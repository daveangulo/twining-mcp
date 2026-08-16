/**
 * SQLite backend parity suite (FOUNDATION-PLAN W2.2).
 * Exercises every interface method against the sqlite stores, mirroring the
 * file-backend semantics the engine layer depends on, plus a cross-backend
 * parity run: the same operation sequence applied to both backends must
 * produce identical read models (modulo generated ids/timestamps).
 *
 * Skipped entirely on runtimes without node:sqlite (Node < 22.13) — the
 * backend is opt-in and falls back to files there.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDatabase,
  vectorToBlob,
  blobToVector,
  type SqliteDatabase,
} from "../src/storage/sqlite/db.js";
import {
  SqliteAgentStore,
  SqliteBlackboardStore,
  SqliteDecisionStore,
  SqliteGraphStore,
  SqliteHandoffStore,
  SqliteIndexManager,
} from "../src/storage/sqlite/sqlite-stores.js";
import { createStores } from "../src/storage/backend-factory.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionEngine } from "../src/engine/decisions.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";
import {
  enterReadOnlyMode,
  exitReadOnlyMode,
} from "../src/storage/file-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { HandoffRecord, TwiningConfig } from "../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let db: SqliteDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-sqlite-"));
  if (HAS_SQLITE) db = openDatabase(dir);
});

afterEach(() => {
  exitReadOnlyMode();
  try {
    db?.close();
  } catch {
    // already closed
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const handoffInput = (
  summary: string,
  results: HandoffRecord["results"] = [],
  extra?: Partial<Omit<HandoffRecord, "id" | "created_at">>,
): Omit<HandoffRecord, "id" | "created_at"> => ({
  source_agent: "alpha",
  target_agent: "beta",
  scope: "src/",
  summary,
  results,
  context_snapshot: {
    decision_ids: [],
    warning_ids: [],
    finding_ids: [],
    summaries: [],
  },
  ...extra,
});

describe.skipIf(!HAS_SQLITE)("sqlite backend", () => {
  describe("SqliteBlackboardStore", () => {
    it("appends and reads back in insertion order with generated ids", async () => {
      const store = new SqliteBlackboardStore(db);
      const a = await store.append({
        entry_type: "finding",
        summary: "first",
        detail: "",
        tags: ["x"],
        scope: "src/auth/",
        agent_id: "main",
      });
      await store.append({
        entry_type: "warning",
        summary: "second",
        detail: "",
        tags: ["y"],
        scope: "src/db/",
        agent_id: "main",
      });
      expect(a.id).toHaveLength(26); // ULID
      const { entries, total_count } = await store.read();
      expect(total_count).toBe(2);
      expect(entries.map((e) => e.summary)).toEqual(["first", "second"]);
    });

    it("applies entry_types, tags, two-way scope prefix, since, and last-N limit", async () => {
      const store = new SqliteBlackboardStore(db);
      for (let i = 0; i < 5; i++) {
        await store.append({
          entry_type: i % 2 === 0 ? "finding" : "warning",
          summary: `e${i}`,
          detail: "",
          tags: i < 3 ? ["auth"] : ["db"],
          scope: i < 4 ? "src/auth/" : "src/",
          agent_id: "main",
        });
      }
      const byType = await store.read({ entry_types: ["warning"] });
      expect(byType.entries.map((e) => e.summary)).toEqual(["e1", "e3"]);

      const byTag = await store.read({ tags: ["db"] });
      expect(byTag.entries.map((e) => e.summary)).toEqual(["e3", "e4"]);

      // Two-way prefix: filter "src/auth/session.ts" matches "src/auth/" and "src/"
      const byScope = await store.read({ scope: "src/auth/session.ts" });
      expect(byScope.total_count).toBe(5);

      const limited = await store.read({ limit: 2 });
      expect(limited.total_count).toBe(5); // total before limit
      expect(limited.entries.map((e) => e.summary)).toEqual(["e3", "e4"]);
    });

    it("recent returns newest-first; dismiss reports found and not_found", async () => {
      const store = new SqliteBlackboardStore(db);
      const first = await store.append({
        entry_type: "finding",
        summary: "old",
        detail: "",
        tags: [],
        scope: "project",
        agent_id: "main",
      });
      await store.append({
        entry_type: "finding",
        summary: "new",
        detail: "",
        tags: [],
        scope: "project",
        agent_id: "main",
      });
      const recent = await store.recent(1);
      expect(recent.map((e) => e.summary)).toEqual(["new"]);

      const res = await store.dismiss([first.id, "nope"]);
      expect(res.dismissed).toEqual([first.id]);
      expect(res.not_found).toEqual(["nope"]);
      expect((await store.read()).total_count).toBe(1);
    });
  });

  describe("SqliteDecisionStore", () => {
    const decisionInput = (summary: string, scope = "src/") => ({
      agent_id: "main",
      domain: "architecture",
      scope,
      summary,
      context: "ctx",
      rationale: "because",
      alternatives: [],
      confidence: "medium" as const,
      affected_files: ["src/a.ts"],
      affected_symbols: ["doThing"],
      reversible: true,
    });

    it("updateStatus reports persisted honestly (D14 fail-loud)", async () => {
      const store = new SqliteDecisionStore(db);
      const d = await store.create(decisionInput("persist check") as never);
      expect(await store.updateStatus(d.id, "provisional")).toEqual({
        persisted: true,
      });
      expect(await store.updateStatus("missing-id", "active")).toEqual({
        persisted: false,
      });
    });

    it("creates with active status and empty commit_hashes; get returns null when missing", async () => {
      const store = new SqliteDecisionStore(db);
      const d = await store.create(decisionInput("choose X"));
      expect(d.status).toBe("active");
      expect(d.commit_hashes).toEqual([]);
      expect(await store.get(d.id)).toEqual(d);
      expect(await store.get("missing")).toBeNull();
    });

    it("getIndex mirrors decisions in insertion order", async () => {
      const store = new SqliteDecisionStore(db);
      const a = await store.create(decisionInput("first"));
      const b = await store.create(decisionInput("second"));
      const index = await store.getIndex();
      expect(index.map((e) => e.id)).toEqual([a.id, b.id]);
      expect(index[0]).toMatchObject({
        summary: "first",
        status: "active",
        affected_files: ["src/a.ts"],
        affected_symbols: ["doThing"],
        commit_hashes: [],
      });
    });

    it("updateStatus applies status and extras, reports missing ids as persisted:false", async () => {
      const store = new SqliteDecisionStore(db);
      const d = await store.create(decisionInput("mutate me"));
      await store.updateStatus(d.id, "superseded", { superseded_by: "Z" });
      const updated = await store.get(d.id);
      expect(updated?.status).toBe("superseded");
      expect(updated?.superseded_by).toBe("Z");
      await expect(store.updateStatus("missing", "active")).resolves.toEqual({
        persisted: false,
      });
    });

    it("DecisionEngine.decide over sqlite writes the superseded_by back-link (#31)", async () => {
      const store = new SqliteDecisionStore(db);
      const engine = new DecisionEngine(
        store,
        new BlackboardEngine(new SqliteBlackboardStore(db)),
      );
      const first = await engine.decide({
        domain: "architecture",
        scope: "src/",
        summary: "first",
        context: "ctx",
        rationale: "because",
      });
      const second = await engine.decide({
        domain: "architecture",
        scope: "src/",
        summary: "second",
        context: "ctx",
        rationale: "because",
        supersedes: first.id,
      });
      const retired = await store.get(first.id);
      expect(retired?.status).toBe("superseded");
      expect(retired?.superseded_by).toBe(second.id);
    });

    it("linkCommit dedupes and throws on missing; getByCommitHash finds it", async () => {
      const store = new SqliteDecisionStore(db);
      const d = await store.create(decisionInput("link me"));
      await store.linkCommit(d.id, "abc123");
      await store.linkCommit(d.id, "abc123");
      expect((await store.get(d.id))?.commit_hashes).toEqual(["abc123"]);
      await expect(store.linkCommit("missing", "abc")).rejects.toThrow(
        "Decision not found: missing",
      );
      const found = await store.getByCommitHash("abc123");
      expect(found.map((x) => x.id)).toEqual([d.id]);
    });

    it("getByScope matches prefix both ways plus affected files/symbols, newest first", async () => {
      const store = new SqliteDecisionStore(db);
      await store.create(decisionInput("scoped", "src/auth/"));
      await store.create({ ...decisionInput("by-file", "lib/"), affected_files: ["src/auth/x.ts"] });
      await store.create({ ...decisionInput("by-symbol", "lib/"), affected_files: [], affected_symbols: ["src/auth/"] });
      await store.create({ ...decisionInput("unrelated", "docs/"), affected_files: [], affected_symbols: [] });
      const found = await store.getByScope("src/auth/");
      expect(found.map((d) => d.summary).sort()).toEqual(["by-file", "by-symbol", "scoped"]);
    });
  });

  describe("SqliteGraphStore", () => {
    it("upserts entities by name+type, merging properties and bumping updated_at", async () => {
      const store = new SqliteGraphStore(db);
      const e1 = await store.addEntity({ name: "auth", type: "module", properties: { a: "1" } });
      const e2 = await store.addEntity({ name: "auth", type: "module", properties: { b: "2" } });
      expect(e2.id).toBe(e1.id);
      expect(e2.properties).toEqual({ a: "1", b: "2" });
      expect(await store.getEntities()).toHaveLength(1);
      // Different type → different entity
      await store.addEntity({ name: "auth", type: "concept" });
      expect(await store.getEntities()).toHaveLength(2);
      expect(await store.getEntityByName("auth", "concept")).toHaveLength(1);
      expect(await store.getEntityById(e1.id)).toMatchObject({ name: "auth" });
    });

    it("resolves relations by id or unique name; NOT_FOUND and AMBIGUOUS_ENTITY error codes", async () => {
      const store = new SqliteGraphStore(db);
      const a = await store.addEntity({ name: "a", type: "module" });
      await store.addEntity({ name: "b", type: "module" });
      const rel = await store.addRelation({ source: a.id, target: "b", type: "depends_on" });
      expect(rel.source).toBe(a.id);
      expect((await store.getRelations())[0]!.id).toBe(rel.id);

      await expect(
        store.addRelation({ source: "ghost", target: "b", type: "depends_on" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await store.addEntity({ name: "dup", type: "module" });
      await store.addEntity({ name: "dup", type: "concept" });
      await expect(
        store.addRelation({ source: "dup", target: "b", type: "depends_on" }),
      ).rejects.toMatchObject({ code: "AMBIGUOUS_ENTITY" });
    });

    it("upserts relations by (source, target, type), merging properties (wave C)", async () => {
      const store = new SqliteGraphStore(db);
      const a = await store.addEntity({ name: "src/a.ts", type: "file" });
      const b = await store.addEntity({ name: "D1", type: "concept" });
      const first = await store.addRelation({
        source: a.id,
        target: b.id,
        type: "decided_by",
        properties: { decision_summary: "original" },
      });
      const second = await store.addRelation({
        source: a.id,
        target: b.id,
        type: "decided_by",
        properties: { origin: "derived" },
      });
      expect(second.id).toBe(first.id);
      const relations = await store.getRelations();
      expect(relations).toHaveLength(1);
      expect(relations[0]!.properties).toEqual({
        decision_summary: "original",
        origin: "derived",
      });
      await store.addRelation({ source: a.id, target: b.id, type: "tested_by" });
      expect(await store.getRelations()).toHaveLength(2);
    });

    it("upsert lookup is indexed and merges into the seq-first row OF THE SAME TYPE", async () => {
      // The composite index backs the targeted (source, target) lookup that
      // replaced the O(N) full-table scan.
      const idx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_relations_source_target'",
        )
        .get();
      expect(idx).toBeTruthy();

      const store = new SqliteGraphStore(db);
      const a = await store.addEntity({ name: "src/a.ts", type: "file" });
      const b = await store.addEntity({ name: "D1", type: "concept" });
      // Manufacture interleaved legacy duplicates of TWO types on one pair —
      // the upsert must merge into the seq-first row of the MATCHING type,
      // not the seq-first row overall.
      const ins = db.prepare(
        "INSERT INTO relations (id, source, target, data) VALUES (?, ?, ?, ?)",
      );
      const mk = (id: string, type: string, properties: Record<string, string>) => {
        const row = {
          id,
          source: a.id,
          target: b.id,
          type,
          properties,
          created_at: new Date().toISOString(),
        };
        ins.run(id, a.id, b.id, JSON.stringify(row));
      };
      mk("T1", "tested_by", { t: "first" });
      mk("D1", "decided_by", { d: "first" });
      mk("D2", "decided_by", { d: "second" });

      const merged = await store.addRelation({
        source: a.id,
        target: b.id,
        type: "decided_by",
        properties: { extra: "x" },
      });
      expect(merged.id).toBe("D1");
      expect(merged.properties).toEqual({ d: "first", extra: "x" });
      // Nothing inserted; the tested_by row untouched.
      expect(await store.getRelations()).toHaveLength(3);
    });

    it("removeEntities cascades relations and reports counts", async () => {
      const store = new SqliteGraphStore(db);
      const a = await store.addEntity({ name: "a", type: "module" });
      const b = await store.addEntity({ name: "b", type: "module" });
      await store.addRelation({ source: a.id, target: b.id, type: "depends_on" });
      await store.addRelation({ source: b.id, target: a.id, type: "depends_on" });
      const res = await store.removeEntities(new Set([a.id]));
      expect(res).toEqual({ removedEntities: 1, removedRelations: 2 });
      expect(await store.getEntities()).toHaveLength(1);
      expect(await store.getRelations()).toHaveLength(0);
    });

    it("removeRelations removes by id, ignores unknown ids, and reports the count", async () => {
      const store = new SqliteGraphStore(db);
      const a = await store.addEntity({ name: "a", type: "module" });
      const b = await store.addEntity({ name: "b", type: "module" });
      const r1 = await store.addRelation({ source: a.id, target: b.id, type: "depends_on" });
      const r2 = await store.addRelation({ source: b.id, target: a.id, type: "depends_on" });
      const res = await store.removeRelations(new Set([r1.id, "nope"]));
      expect(res).toEqual({ removed: 1 });
      const left = await store.getRelations();
      expect(left).toHaveLength(1);
      expect(left[0]!.id).toBe(r2.id);
    });
  });

  describe("SqliteAgentStore", () => {
    it("upserts with capability union; touch creates minimal records", async () => {
      const store = new SqliteAgentStore(db);
      await store.upsert({ agent_id: "w1", capabilities: ["Testing"], role: "worker" });
      const merged = await store.upsert({ agent_id: "w1", capabilities: ["review"] });
      expect(merged.capabilities.sort()).toEqual(["review", "testing"]);
      expect(merged.role).toBe("worker");

      const touched = await store.touch("w2");
      expect(touched.capabilities).toEqual([]);
      expect(await store.getAll()).toHaveLength(2);
      expect(await store.get("w2")).not.toBeNull();
      expect(await store.get("ghost")).toBeNull();
    });

    it("findByCapabilities OR-matches normalized tags; empty input returns []", async () => {
      const store = new SqliteAgentStore(db);
      await store.upsert({ agent_id: "w1", capabilities: ["testing"] });
      await store.upsert({ agent_id: "w2", capabilities: ["docs"] });
      const found = await store.findByCapabilities(["TESTING", "nothing"]);
      expect(found.map((a) => a.agent_id)).toEqual(["w1"]);
      expect(await store.findByCapabilities([])).toEqual([]);
    });
  });

  describe("SqliteHandoffStore", () => {
    it("computes result_status for the index entry: empty=completed, uniform, mixed", async () => {
      const store = new SqliteHandoffStore(db);
      await store.create(handoffInput("empty"));
      await store.create(handoffInput("uniform", [
        { description: "a", status: "failed" },
        { description: "b", status: "failed" },
      ]));
      await store.create(handoffInput("mixed", [
        { description: "a", status: "completed" },
        { description: "b", status: "failed" },
      ]));
      const list = await store.list({});
      const byName = Object.fromEntries(list.map((e) => [e.summary, e.result_status]));
      expect(byName).toEqual({ empty: "completed", uniform: "failed", mixed: "mixed" });
    });

    it("amendMetadata updates record and file-scoped retrieval (field D11)", async () => {
      const store = new SqliteDecisionStore(db);
      const d = await store.create({
        agent_id: "main",
        domain: "architecture",
        scope: "src/",
        summary: "amendable",
        context: "ctx",
        rationale: "because",
        alternatives: [],
        confidence: "medium" as const,
        affected_files: [],
        affected_symbols: [],
        reversible: true,
      });
      await store.amendMetadata(d.id, {
        add_affected_files: ["specs/target.md"],
        add_affected_symbols: ["Klass.method"],
        amendment: {
          amended_at: new Date().toISOString(),
          amended_by: "repair",
          added_files: ["specs/target.md"],
          added_symbols: ["Klass.method"],
        },
      });
      // Missing id: silent no-op, matching updateStatus semantics.
      await expect(
        store.amendMetadata("missing", {
          add_affected_files: ["x.md"],
          add_affected_symbols: [],
          amendment: {
            amended_at: new Date().toISOString(),
            amended_by: "repair",
            added_files: ["x.md"],
            added_symbols: [],
          },
        }),
      ).resolves.toBeUndefined();
      const stored = await store.get(d.id);
      expect(stored!.affected_files).toEqual(["specs/target.md"]);
      expect(stored!.amendments).toHaveLength(1);
      const byFile = await store.getByScope("specs/target.md");
      expect(byFile.map((x) => x.id)).toContain(d.id);
    });

    it("a scopeless handoff reads as project scope, never match-everything (field D12)", async () => {
      const store = new SqliteHandoffStore(db);
      await store.create(handoffInput("scopeless", [], { scope: undefined }));
      expect(await store.list({ scope: "src/auth/" })).toHaveLength(0);
      expect(await store.list({ scope: "project" })).toHaveLength(1);
    });

    it("lists newest-first with filters and limit; acknowledge updates record and index", async () => {
      const store = new SqliteHandoffStore(db);
      const h1 = await store.create(handoffInput("one"));
      await store.create(handoffInput("two", [], { source_agent: "other" }));
      const filtered = await store.list({ source_agent: "alpha" });
      expect(filtered.map((e) => e.summary)).toEqual(["one"]);
      const limited = await store.list({ limit: 1 });
      expect(limited).toHaveLength(1);

      const acked = await store.acknowledge(h1.id, "beta");
      expect(acked.acknowledged_by).toBe("beta");
      expect(acked.acknowledged_at).toBeTruthy();
      const entry = (await store.list({})).find((e) => e.id === h1.id)!;
      expect(entry.acknowledged).toBe(true);
      expect(await store.get(h1.id)).toMatchObject({ acknowledged_by: "beta" });
      await expect(store.acknowledge("missing", "x")).rejects.toThrow(
        "Handoff not found: missing",
      );
    });
  });

  describe("SqliteIndexManager", () => {
    it("loads the default empty index; add/replace/remove/getVector round-trip exactly", async () => {
      const im = new SqliteIndexManager(db);
      const empty = await im.load("blackboard");
      expect(empty).toEqual({ model: "all-MiniLM-L6-v2", dimension: 384, entries: [] });

      const v = [0.123456789012345, -1.5, 42.000000001];
      await im.addEntry("blackboard", "e1", v);
      expect(await im.getVector("blackboard", "e1")).toEqual(v); // float64 exact
      await im.addEntry("blackboard", "e1", [9, 9, 9]); // replace
      expect(await im.getVector("blackboard", "e1")).toEqual([9, 9, 9]);

      await im.addEntry("decisions", "d1", [1, 2, 3]); // separate namespace
      expect((await im.load("blackboard")).entries).toHaveLength(1);

      await im.removeEntries("blackboard", ["e1", "ghost"]);
      expect(await im.getVector("blackboard", "e1")).toBeNull();

      await im.save("decisions", { model: "m", dimension: 3, entries: [{ id: "x", vector: [1, 1, 1] }] });
      expect((await im.load("decisions")).entries).toEqual([{ id: "x", vector: [1, 1, 1] }]);
    });

    it("vector blob round-trip preserves float64 precision", () => {
      const v = [Math.PI, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER + 0.5];
      expect(blobToVector(vectorToBlob(v))).toEqual(v);
    });
  });

  describe("format version gate", () => {
    it("refuses writes in read-only mode with FORMAT_VERSION_TOO_NEW", async () => {
      const store = new SqliteBlackboardStore(db);
      enterReadOnlyMode("newer format");
      await expect(
        store.append({
          entry_type: "finding",
          summary: "nope",
          detail: "",
          tags: [],
          scope: "project",
          agent_id: "main",
        }),
      ).rejects.toMatchObject({ code: "FORMAT_VERSION_TOO_NEW" });
      exitReadOnlyMode();
      expect((await store.read()).total_count).toBe(0);
    });
  });

  describe("openDatabase schema versioning", () => {
    it("stamps user_version and refuses a newer schema", () => {
      db.exec("PRAGMA user_version = 99;");
      db.close();
      expect(() => openDatabase(dir)).toThrow(/newer than this release/);
      // restore so afterEach close doesn't throw
      const { DatabaseSync } = require("node:sqlite") as {
        DatabaseSync: new (p: string) => SqliteDatabase;
      };
      db = new DatabaseSync(path.join(dir, "twining.db"));
      db.exec("PRAGMA user_version = 1;");
    });
  });

  describe("backend factory", () => {
    const cfg = (backend: "files" | "sqlite"): TwiningConfig =>
      ({ ...DEFAULT_CONFIG, storage: { backend } });

    it("returns sqlite stores when requested and available", () => {
      const sub = fs.mkdtempSync(path.join(os.tmpdir(), "twining-bf-"));
      try {
        const stores = createStores(sub, cfg("sqlite"));
        expect(stores.backend).toBe("sqlite");
        expect(fs.existsSync(path.join(sub, "twining.db"))).toBe(true);
      } finally {
        fs.rmSync(sub, { recursive: true, force: true });
      }
    });

    it("defaults to the file backend", () => {
      const sub = fs.mkdtempSync(path.join(os.tmpdir(), "twining-bf-"));
      try {
        const stores = createStores(sub, cfg("files"));
        expect(stores.backend).toBe("files");
        expect(stores.blackboardStore).toBeInstanceOf(BlackboardStore);
        expect(fs.existsSync(path.join(sub, "twining.db"))).toBe(false);
      } finally {
        fs.rmSync(sub, { recursive: true, force: true });
      }
    });
  });

  describe("engine over sqlite stores", () => {
    it("decide() does not cross-post to the blackboard (issue #30)", async () => {
      const { BlackboardEngine } = await import("../src/engine/blackboard.js");
      const { DecisionEngine } = await import("../src/engine/decisions.js");
      const bbStore = new SqliteBlackboardStore(db);
      const dcStore = new SqliteDecisionStore(db);
      const bbEngine = new BlackboardEngine(bbStore);
      const dcEngine = new DecisionEngine(dcStore, bbEngine);

      await dcEngine.decide({
        domain: "implementation",
        scope: "src/db/",
        summary: "Use sqlite for storage",
        context: "ctx",
        rationale: "why",
      });

      const { entries } = await bbEngine.read({ entry_types: ["decision"] });
      expect(entries).toHaveLength(0);
      const index = await dcStore.getIndex();
      expect(index).toHaveLength(1);
      expect(index[0]!.summary).toBe("Use sqlite for storage");
    });
  });

  describe("cross-backend parity", () => {
    it("an identical operation sequence yields identical read models (modulo ids/timestamps)", async () => {
      const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-files-"));
      try {
        const backends = {
          files: {
            bb: new BlackboardStore(fileDir),
            dc: new DecisionStore(path.join(fileDir)),
            gr: new GraphStore(fileDir),
          },
          sqlite: {
            bb: new SqliteBlackboardStore(db),
            dc: new SqliteDecisionStore(db),
            gr: new SqliteGraphStore(db),
          },
        };
        // file DecisionStore needs its layout
        fs.mkdirSync(path.join(fileDir, "decisions"), { recursive: true });
        fs.writeFileSync(path.join(fileDir, "decisions", "index.json"), "[]");

        for (const { bb, dc, gr } of Object.values(backends)) {
          await bb.append({ entry_type: "finding", summary: "f1", detail: "d", tags: ["t"], scope: "src/", agent_id: "main" });
          await bb.append({ entry_type: "warning", summary: "w1", detail: "", tags: [], scope: "src/auth/", agent_id: "main" });
          const d = await dc.create({
            agent_id: "main", domain: "impl", scope: "src/", summary: "dec1",
            context: "c", rationale: "r", alternatives: [], confidence: "high",
            affected_files: [], affected_symbols: [], reversible: true,
          } as never);
          await dc.updateStatus(d.id, "provisional");
          const e1 = await gr.addEntity({ name: "auth", type: "module" });
          await gr.addEntity({ name: "db", type: "module" });
          await gr.addRelation({ source: e1.id, target: "db", type: "depends_on" });
        }

        const project = async (b: (typeof backends)["files"]) => ({
          bbSummaries: (await b.bb.read()).entries.map((e) => [e.entry_type, e.summary, e.scope]),
          warnings: (await b.bb.read({ entry_types: ["warning"] })).entries.map((e) => e.summary),
          decisions: (await b.dc.getIndex()).map((e) => [e.summary, e.status, e.domain]),
          entities: (await b.gr.getEntities()).map((e) => [e.name, e.type]),
          relationShape: (await b.gr.getRelations()).map((r) => r.type),
        });

        expect(await project(backends.sqlite as never)).toEqual(
          await project(backends.files),
        );
      } finally {
        fs.rmSync(fileDir, { recursive: true, force: true });
      }
    });
  });
});
