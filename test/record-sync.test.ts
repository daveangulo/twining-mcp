/**
 * W2.3 git sync layer: export tree + ingest convergence.
 * Skipped where node:sqlite is unavailable (the sync layer only applies to
 * the sqlite backend; the file backend's committed files remain canonical).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type SqliteDatabase } from "../src/storage/sqlite/db.js";
import {
  RecordExporter,
  stableStringify,
  withRecordExport,
} from "../src/storage/sync/record-export.js";
import { ingestRecords } from "../src/storage/sync/record-ingest.js";
import { createStores, type StoreSet } from "../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { TwiningConfig } from "../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

let dirA: string;
let dirB: string;

beforeEach(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "twining-sync-a-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "twining-sync-b-"));
});

afterEach(() => {
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

async function seed(stores: StoreSet) {
  const entry = await stores.blackboardStore.append({
    entry_type: "finding",
    summary: "auth tokens in localStorage",
    detail: "d",
    tags: ["auth"],
    scope: "src/auth/",
    agent_id: "main",
  });
  const decision = await stores.decisionStore.create({
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
  } as never);
  const e1 = await stores.graphStore.addEntity({ name: "auth", type: "module" });
  await stores.graphStore.addEntity({ name: "db", type: "module" });
  const rel = await stores.graphStore.addRelation({
    source: e1.id,
    target: "db",
    type: "depends_on",
  });
  const handoff = await stores.handoffStore.create({
    source_agent: "alpha",
    target_agent: "beta",
    scope: "src/",
    summary: "handoff one",
    results: [],
    context_snapshot: {
      decision_ids: [],
      warning_ids: [],
      finding_ids: [],
      summaries: [],
    },
  });
  return { entry, decision, entity: e1, relation: rel, handoff };
}

async function project(stores: StoreSet) {
  return {
    posts: (await stores.blackboardStore.read()).entries.map((e) => [
      e.id,
      e.summary,
      e.timestamp,
    ]),
    decisions: (await stores.decisionStore.getIndex()).map((d) => [
      d.id,
      d.summary,
      d.status,
    ]),
    entities: (await stores.graphStore.getEntities())
      .map((e) => [e.id, e.name, e.type] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    relations: (await stores.graphStore.getRelations()).map((r) => [
      r.id,
      r.source,
      r.target,
    ]),
    handoffs: (await stores.handoffStore.list({})).map((h) => [
      h.id,
      h.summary,
      h.acknowledged,
      h.result_status,
    ]),
  };
}

describe.skipIf(!HAS_SQLITE)("record export tree", () => {
  it("stableStringify produces identical bytes regardless of key order", () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  it("mirrors writes into the expected layout and unlinks on removal", async () => {
    fs.mkdirSync(path.join(dirA, ".twining"), { recursive: true });
    const stores = createStores(path.join(dirA, ".twining"), sqliteConfig());
    const { entry, decision, entity, relation, handoff } = await seed(stores);

    const rec = path.join(dirA, ".twining", "records");
    const month = entry.timestamp.slice(0, 7);
    const postFile = path.join(rec, "posts", month, `${entry.id}.json`);
    expect(fs.existsSync(postFile)).toBe(true);
    expect(
      fs.existsSync(path.join(rec, "decisions", `${decision.id}.json`)),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(rec, "graph", "entities", `${entity.id}.json`)),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(rec, "graph", "relations", `${relation.id}.json`)),
    ).toBe(true);
    expect(fs.existsSync(path.join(rec, "handoffs", `${handoff.id}.json`))).toBe(
      true,
    );

    // Deterministic content: file equals stable serialization of the record.
    expect(fs.readFileSync(postFile, "utf-8")).toBe(stableStringify(entry));

    // Mutations rewrite the same file.
    await stores.decisionStore.updateStatus(decision.id, "superseded");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(rec, "decisions", `${decision.id}.json`), "utf-8"),
      ).status,
    ).toBe("superseded");
    await stores.handoffStore.acknowledge(handoff.id, "beta");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(rec, "handoffs", `${handoff.id}.json`), "utf-8"),
      ).acknowledged_by,
    ).toBe("beta");

    // Removals unlink, including cascaded relations.
    await stores.blackboardStore.dismiss([entry.id]);
    expect(fs.existsSync(postFile)).toBe(false);
    await stores.graphStore.removeEntities(new Set([entity.id]));
    expect(
      fs.existsSync(path.join(rec, "graph", "entities", `${entity.id}.json`)),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(rec, "graph", "relations", `${relation.id}.json`)),
    ).toBe(false);
  });

  it("removeRelations unlinks the relation mirror but never a not-yet-ingested file", async () => {
    fs.mkdirSync(path.join(dirA, ".twining"), { recursive: true });
    const stores = createStores(path.join(dirA, ".twining"), sqliteConfig());
    const { relation } = await seed(stores);
    const rec = path.join(dirA, ".twining", "records");
    const relFile = path.join(rec, "graph", "relations", `${relation.id}.json`);
    expect(fs.existsSync(relFile)).toBe(true);

    // A record file for an id the store does not hold (exported by another
    // machine, ingest pending) must survive a removal that names its id.
    const foreignFile = path.join(rec, "graph", "relations", "foreign-rel.json");
    fs.writeFileSync(foreignFile, JSON.stringify({ id: "foreign-rel" }));

    const res = await stores.graphStore.removeRelations(
      new Set([relation.id, "foreign-rel", "missing"]),
    );
    expect(res.removed).toBe(1);
    expect(fs.existsSync(relFile)).toBe(false);
    expect(fs.existsSync(foreignFile)).toBe(true);
  });

  it("amendMetadata rewrites the decision mirror (field D11 invariant 2)", async () => {
    fs.mkdirSync(path.join(dirA, ".twining"), { recursive: true });
    const stores = createStores(path.join(dirA, ".twining"), sqliteConfig());
    const { decision } = await seed(stores);

    await stores.decisionStore.amendMetadata(decision.id, {
      add_affected_files: ["specs/amended.md"],
      add_affected_symbols: [],
      amendment: {
        amended_at: new Date().toISOString(),
        amended_by: "repair",
        added_files: ["specs/amended.md"],
        added_symbols: [],
      },
    });

    const mirrored = JSON.parse(
      fs.readFileSync(
        path.join(dirA, ".twining", "records", "decisions", `${decision.id}.json`),
        "utf-8",
      ),
    );
    expect(mirrored.affected_files).toContain("specs/amended.md");
    expect(mirrored.amendments).toHaveLength(1);
  });

  it("export_records: false disables the tree", async () => {
    const cfg = sqliteConfig();
    cfg.storage!.export_records = false;
    fs.mkdirSync(path.join(dirA, ".twining"), { recursive: true });
    const stores = createStores(path.join(dirA, ".twining"), cfg);
    await seed(stores);
    expect(fs.existsSync(path.join(dirA, ".twining", "records"))).toBe(false);
  });
});

describe.skipIf(!HAS_SQLITE)("record ingest", () => {
  it("round-trip: a fresh database converges to A's read model from the tree alone", async () => {
    const twA = path.join(dirA, ".twining");
    fs.mkdirSync(twA, { recursive: true });
    const storesA = createStores(twA, sqliteConfig());
    await seed(storesA);
    await storesA.decisionStore.updateStatus(
      (await storesA.decisionStore.getIndex())[0]!.id,
      "provisional",
    );

    // Clone: only the records tree travels (twining.db is gitignored).
    const twB = path.join(dirB, ".twining");
    fs.mkdirSync(twB, { recursive: true });
    fs.cpSync(path.join(twA, "records"), path.join(twB, "records"), {
      recursive: true,
    });

    // createStores runs ingest on startup.
    const storesB = createStores(twB, sqliteConfig());
    expect(await project(storesB)).toEqual(await project(storesA));
  });

  it("is idempotent and reports zero work on a converged database", async () => {
    const twA = path.join(dirA, ".twining");
    fs.mkdirSync(twA, { recursive: true });
    const stores = createStores(twA, sqliteConfig());
    await seed(stores);
    const db = openDatabase(twA);
    const stats = ingestRecords(db, twA);
    expect(stats).toEqual({
      inserted: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      lifecycle_reverts: 0,
    });
    db.close();
  });

  it("counts lifecycle reverts when file-wins downgrades a decision's status (D14)", async () => {
    const twA = path.join(dirA, ".twining");
    fs.mkdirSync(twA, { recursive: true });
    const stores = createStores(twA, sqliteConfig());
    const { decision } = await seed(stores);
    await stores.decisionStore.updateStatus(decision.id, "overridden", {
      overridden_by: "the-author",
      override_reason: "withdrawn",
    });

    // Simulate a git operation restoring the committed pre-override bytes of
    // the mirror record (the D14 field mechanism).
    const file = path.join(twA, "records", "decisions", `${decision.id}.json`);
    const reverted = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    reverted.status = "provisional";
    delete reverted.overridden_by;
    delete reverted.override_reason;
    fs.writeFileSync(file, JSON.stringify(reverted));

    const db = openDatabase(twA);
    const stats = ingestRecords(db, twA);
    // File-wins still applies (the W2.3 invariant is untouched) — but the
    // downgrade is counted instead of silent.
    expect(stats.lifecycle_reverts).toBe(1);
    expect(stats.updated).toBe(1);
    db.close();
    const after = await stores.decisionStore.get(decision.id);
    expect(after!.status).toBe("provisional");
  });

  it("does not count sanctioned downgrades (a teammate's reconsider arriving via git)", async () => {
    const twA = path.join(dirA, ".twining");
    fs.mkdirSync(twA, { recursive: true });
    const stores = createStores(twA, sqliteConfig());
    const { decision } = await seed(stores);

    // db has the decision active; the pulled mirror carries a committed
    // active→provisional reconsider from another machine — a first-class
    // flow, not a discarded write. Must NOT fire the revert alarm.
    const file = path.join(twA, "records", "decisions", `${decision.id}.json`);
    const pulled = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    pulled.status = "provisional";
    fs.writeFileSync(file, JSON.stringify(pulled));

    const db = openDatabase(twA);
    const stats = ingestRecords(db, twA);
    expect(stats.updated).toBe(1);
    expect(stats.lifecycle_reverts).toBe(0);
    db.close();
  });

  it("union-merges two branches' trees (design D2)", async () => {
    const twA = path.join(dirA, ".twining");
    const twB = path.join(dirB, ".twining");
    fs.mkdirSync(twA, { recursive: true });
    fs.mkdirSync(twB, { recursive: true });
    const storesA = createStores(twA, sqliteConfig());
    const storesB = createStores(twB, sqliteConfig());
    await storesA.blackboardStore.append({
      entry_type: "finding",
      summary: "from branch A",
      detail: "",
      tags: [],
      scope: "src/",
      agent_id: "a",
    });
    await storesB.blackboardStore.append({
      entry_type: "warning",
      summary: "from branch B",
      detail: "",
      tags: [],
      scope: "src/",
      agent_id: "b",
    });

    // Simulate git merging the two export trees (distinct ULIDs — set union).
    fs.cpSync(path.join(twB, "records"), path.join(twA, "records"), {
      recursive: true,
    });

    const db = openDatabase(twA);
    const stats = ingestRecords(db, twA);
    expect(stats.inserted).toBe(1);
    expect(stats.deleted).toBe(0);
    db.close();

    const merged = createStores(twA, sqliteConfig());
    const { entries } = await merged.blackboardStore.read();
    expect(entries.map((e) => e.summary).sort()).toEqual([
      "from branch A",
      "from branch B",
    ]);
  });

  it("propagates updates (file wins) and deletions from the tree", async () => {
    const twA = path.join(dirA, ".twining");
    fs.mkdirSync(twA, { recursive: true });
    const stores = createStores(twA, sqliteConfig());
    const { entry, decision } = await seed(stores);

    // Simulate a pulled update: rewrite the decision record with a new status.
    const decFile = path.join(twA, "records", "decisions", `${decision.id}.json`);
    const pulled = JSON.parse(fs.readFileSync(decFile, "utf-8"));
    pulled.status = "overridden";
    fs.writeFileSync(decFile, stableStringify(pulled));
    // Simulate a pulled deletion: the post's record file is gone.
    new RecordExporter(twA).removePost(entry);

    const db = openDatabase(twA);
    const stats = ingestRecords(db, twA);
    expect(stats.updated).toBe(1);
    expect(stats.deleted).toBe(1);
    // A file-wins UPGRADE (active → overridden) is never a revert — pins the
    // detector's direction (mutation `<` → `!==` must fail here).
    expect(stats.lifecycle_reverts).toBe(0);
    db.close();

    const after = createStores(twA, sqliteConfig());
    expect(
      (await after.decisionStore.getIndex()).find((d) => d.id === decision.id)!
        .status,
    ).toBe("overridden");
    expect(
      (await after.blackboardStore.read()).entries.find((e) => e.id === entry.id),
    ).toBeUndefined();
  });

  it("never deletes without the corresponding kind directory (guards)", async () => {
    const twA = path.join(dirA, ".twining");
    fs.mkdirSync(twA, { recursive: true });
    const stores = createStores(twA, sqliteConfig());
    await seed(stores);

    // Whole records/ tree missing → skip everything.
    fs.rmSync(path.join(twA, "records"), { recursive: true, force: true });
    const db = openDatabase(twA);
    expect(ingestRecords(db, twA)).toEqual({
      inserted: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      lifecycle_reverts: 0,
    });

    // records/ exists but a single kind dir is missing → that kind untouched.
    fs.mkdirSync(path.join(twA, "records", "decisions"), { recursive: true });
    const stats = ingestRecords(db, twA);
    expect(stats.deleted).toBe(1); // the seeded decision's file is absent from its EXISTING dir
    const posts = db.prepare("SELECT COUNT(*) AS n FROM blackboard").get() as {
      n: number | bigint;
    };
    expect(Number(posts.n)).toBe(1); // posts dir missing → no deletion applied
    db.close();
  });

  it("skips unparseable record files without deleting them", async () => {
    const twA = path.join(dirA, ".twining");
    fs.mkdirSync(path.join(twA, "records", "decisions"), { recursive: true });
    fs.writeFileSync(
      path.join(twA, "records", "decisions", "corrupt.json"),
      "{not json",
    );
    const db = openDatabase(twA);
    const stats = ingestRecords(db, twA);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(
      fs.existsSync(path.join(twA, "records", "decisions", "corrupt.json")),
    ).toBe(true);
    db.close();
  });
});
