/**
 * 2.16.1 — ingest retention (field report 2026-09-04 #3/#4; plan
 * docs/plans/2026-09-05-cross-host-sync-plan.md §4.1). A record file that
 * EXISTS but cannot be read or identified must never make the deletion pass
 * remove its database row. An ABSENT file still deletes (DD-8 unchanged).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type SqliteDatabase } from "../src/storage/sqlite/db.js";
import { RecordExporter } from "../src/storage/sync/record-export.js";
import { ingestRecords } from "../src/storage/sync/record-ingest.js";
import { reconcileEmbeddings } from "../src/storage/sync/embedding-reconcile.js";
import type {
  BlackboardEntry,
  Decision,
  Entity,
  HandoffRecord,
  Relation,
} from "../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const ID = "01M088JCGYRWPX8EYYQNG3G5DB";
const POST_ID = "01M088JCGYRWPX8EYYQNG3G5DC";
const CONFLICT = `<<<<<<< HEAD\n{"id":"${ID}","status":"overridden"}\n=======\n{"id":"${ID}","status":"active"}\n>>>>>>> other\n`;

function decision(): Decision {
  return {
    id: ID,
    timestamp: "2026-09-01T00:00:00.000Z",
    agent_id: "main",
    domain: "architecture",
    scope: "src/",
    summary: "use blackboard pattern",
    context: "c",
    rationale: "r",
    alternatives: [],
    confidence: "high",
    affected_files: [],
    affected_symbols: [],
    reversible: true,
    status: "overridden",
  } as unknown as Decision;
}
function post(): BlackboardEntry {
  return {
    id: POST_ID,
    timestamp: "2026-09-01T00:00:00.000Z",
    agent_id: "main",
    entry_type: "finding",
    summary: "s",
    detail: "d",
    tags: [],
    scope: "src/",
  } as unknown as BlackboardEntry;
}

describe.skipIf(!HAS_SQLITE)("record ingest retention (2.16.1)", () => {
  let dir: string;
  let db: SqliteDatabase;
  let exporter: RecordExporter;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-retain-"));
    db = openDatabase(dir);
    exporter = new RecordExporter(dir);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const decisionFile = () =>
    path.join(dir, "records", "decisions", `${ID}.json`);
  const rows = () =>
    db.prepare("SELECT id, seq FROM decisions ORDER BY id").all() as {
      id: string;
      seq: number | bigint;
    }[];
  function seedDecisionRow() {
    const dec = decision();
    db.prepare(
      "INSERT INTO decisions (id, status, timestamp, data) VALUES (?, ?, ?, ?)",
    ).run(dec.id, dec.status, dec.timestamp, JSON.stringify(dec));
    return dec;
  }

  it("keeps the row when the file holds conflict markers, and a repaired file converges without a new row", () => {
    const dec = seedDecisionRow();
    exporter.decision(dec);
    expect(ingestRecords(db, dir)).toMatchObject({
      inserted: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
    });
    const seqBefore = Number(rows()[0]!.seq);

    fs.writeFileSync(decisionFile(), CONFLICT);
    expect(ingestRecords(db, dir)).toMatchObject({ deleted: 0, skipped: 1 });
    expect(rows().map((r) => r.id)).toEqual([ID]);
    expect(fs.existsSync(decisionFile())).toBe(true);

    exporter.decision(dec); // repair: identical bytes → no update, no insert, same row
    expect(ingestRecords(db, dir)).toMatchObject({
      inserted: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
    });
    expect(Number(rows()[0]!.seq)).toBe(seqBefore);
  });

  it("keeps the row for a 0-byte file", () => {
    seedDecisionRow();
    fs.mkdirSync(path.dirname(decisionFile()), { recursive: true });
    fs.writeFileSync(decisionFile(), "");
    expect(ingestRecords(db, dir)).toMatchObject({ deleted: 0, skipped: 1 });
    expect(rows().map((r) => r.id)).toEqual([ID]);
  });

  it("counts and warns a parseable file whose id is not a string, and keeps the row", () => {
    const dec = seedDecisionRow();
    fs.mkdirSync(path.dirname(decisionFile()), { recursive: true });
    fs.writeFileSync(decisionFile(), JSON.stringify({ ...dec, id: 42 }));
    expect(ingestRecords(db, dir)).toMatchObject({
      deleted: 0,
      skipped: 1,
      inserted: 0,
    });
    expect(rows().map((r) => r.id)).toEqual([ID]);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("non-string id")),
    ).toBe(true);
  });

  it("refuses a parseable file whose id does not match its filename: no stray row, stem row kept", () => {
    const dec = seedDecisionRow();
    fs.mkdirSync(path.dirname(decisionFile()), { recursive: true });
    fs.writeFileSync(decisionFile(), JSON.stringify({ ...dec, id: "OTHERID" }));
    expect(ingestRecords(db, dir)).toMatchObject({
      deleted: 0,
      skipped: 1,
      inserted: 0,
      updated: 0,
    });
    expect(rows().map((r) => r.id)).toEqual([ID]);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes("does not match its filename"),
      ),
    ).toBe(true);
  });

  it("an ABSENT file still deletes its row (file-wins precedence unchanged)", () => {
    seedDecisionRow();
    fs.mkdirSync(path.join(dir, "records", "decisions"), { recursive: true });
    expect(ingestRecords(db, dir)).toMatchObject({ deleted: 1, skipped: 0 });
    expect(rows()).toEqual([]);
  });

  it("retains a post row in a month shard when its file is unparseable", () => {
    const p = post();
    exporter.post(p);
    db.prepare(
      "INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)",
    ).run(p.id, p.entry_type, p.scope, p.timestamp, JSON.stringify(p));
    fs.writeFileSync(exporter.postPath(p), "{not json");
    expect(ingestRecords(db, dir)).toMatchObject({ deleted: 0, skipped: 1 });
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM blackboard WHERE id = ?")
      .get(POST_ID) as { n: number | bigint };
    expect(Number(n.n)).toBe(1);
  });

  it("a healthy new file still inserts (retention never blocks first ingest)", () => {
    exporter.decision(decision());
    expect(ingestRecords(db, dir)).toMatchObject({
      inserted: 1,
      deleted: 0,
      skipped: 0,
    });
    expect(rows().map((r) => r.id)).toEqual([ID]);
  });
  it("counts and warns a JSON body that parses to a falsy scalar (null/false/0/\"\"), and keeps the row", () => {
    // Review finding (2.16.1 pre-tag): JSON.parse("null") is falsy, so the
    // old `if (!record) continue` skipped it silently — no count, no
    // warning — while validate-records flags the same file as non_string_id.
    for (const body of ["null", "false", "0", '""']) {
      seedDecisionRow();
      fs.mkdirSync(path.dirname(decisionFile()), { recursive: true });
      fs.writeFileSync(decisionFile(), body);
      errSpy.mockClear();
      expect(ingestRecords(db, dir)).toMatchObject({
        deleted: 0,
        skipped: 1,
        inserted: 0,
      });
      expect(rows().map((r) => r.id)).toEqual([ID]);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("non-string id")),
      ).toBe(true);
      db.prepare("DELETE FROM decisions").run();
      fs.rmSync(decisionFile(), { force: true });
    }
  });

  it("retains on an unreadable file and deletes on an absent file for EVERY kind", () => {
    const ENT = "01M088JCGYRWPX8EYYQNG3G5E1";
    const REL = "01M088JCGYRWPX8EYYQNG3G5E2";
    const HND = "01M088JCGYRWPX8EYYQNG3G5E3";
    const entity = { id: ENT, name: "src/a.ts", type: "file", properties: {} } as unknown as Entity;
    const relation = { id: REL, source: ENT, target: ENT, type: "depends_on", properties: {} } as unknown as Relation;
    const handoff = {
      id: HND, created_at: "2026-09-01T00:00:00.000Z", source_agent: "a", target_agent: "b",
      scope: "src/", summary: "s", context: "c", results: [],
    } as unknown as HandoffRecord;
    const p = post();
    const dec = decision();
    const kinds: Array<{ table: string; id: string; seed: () => void; file: string; write: () => void }> = [
      { table: "blackboard", id: p.id, file: exporter.postPath(p),
        seed: () => db.prepare("INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)").run(p.id, p.entry_type, p.scope, p.timestamp, JSON.stringify(p)),
        write: () => exporter.post(p) },
      { table: "decisions", id: dec.id, file: decisionFile(),
        seed: () => db.prepare("INSERT INTO decisions (id, status, timestamp, data) VALUES (?, ?, ?, ?)").run(dec.id, dec.status, dec.timestamp, JSON.stringify(dec)),
        write: () => exporter.decision(dec) },
      { table: "entities", id: ENT, file: path.join(dir, "records", "graph", "entities", `${ENT}.json`),
        seed: () => db.prepare("INSERT INTO entities (id, name, type, data) VALUES (?, ?, ?, ?)").run(ENT, entity.name, entity.type, JSON.stringify(entity)),
        write: () => exporter.entity(entity) },
      { table: "relations", id: REL, file: path.join(dir, "records", "graph", "relations", `${REL}.json`),
        seed: () => db.prepare("INSERT INTO relations (id, source, target, data) VALUES (?, ?, ?, ?)").run(REL, ENT, ENT, JSON.stringify(relation)),
        write: () => exporter.relation(relation) },
      { table: "handoffs", id: HND, file: path.join(dir, "records", "handoffs", `${HND}.json`),
        seed: () => db.prepare("INSERT INTO handoffs (id, created_at, data, index_data) VALUES (?, ?, ?, ?)").run(HND, handoff.created_at, JSON.stringify(handoff), "{}"),
        write: () => exporter.handoff(handoff) },
    ];
    const count = (table: string, id: string) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id) as { n: number | bigint }).n);
    for (const k of kinds) { k.seed(); k.write(); }
    expect(ingestRecords(db, dir)).toMatchObject({ inserted: 0, updated: 0, deleted: 0, skipped: 0 });
    for (const k of kinds) fs.writeFileSync(k.file, "{not json");
    expect(ingestRecords(db, dir)).toMatchObject({ deleted: 0, skipped: kinds.length, inserted: 0, updated: 0 });
    for (const k of kinds) expect([k.table, count(k.table, k.id)]).toEqual([k.table, 1]);
    for (const k of kinds) fs.rmSync(k.file);
    expect(ingestRecords(db, dir)).toMatchObject({ deleted: kinds.length, skipped: 0 });
    for (const k of kinds) expect([k.table, count(k.table, k.id)]).toEqual([k.table, 0]);
  });

  it("a retained row keeps its embedding through reconcile (no orphan sweep, no re-embed)", async () => {
    const dec = seedDecisionRow();
    exporter.decision(dec);
    db.prepare("INSERT INTO embeddings (index_name, id, vector, content_hash) VALUES (?, ?, ?, ?)")
      .run("decisions", ID, new Uint8Array(8), "hash");
    fs.writeFileSync(decisionFile(), CONFLICT);
    expect(ingestRecords(db, dir)).toMatchObject({ deleted: 0, skipped: 1 });
    const r = await reconcileEmbeddings(db, { embed: async () => null } as never);
    expect(r.deleted).toBe(0);
    const n = db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE id = ?").get(ID) as { n: number | bigint };
    expect(Number(n.n)).toBe(1);
  });

});
