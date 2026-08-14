/**
 * Legacy duplicate-relation dedup (wave-2 follow-up): field stores hold
 * pre-upsert duplicate (source, target, type) edges; the upsert only
 * prevents new ones and merges into the oldest. This pass removes the rest,
 * folding properties into the survivor under the origin-precedence rule.
 * Removal is by id, so ids that are not globally unique (file backend after
 * a union-style git merge) are skipped rather than over-deleted, and a
 * group whose fold fails (dangling endpoint) is skipped without blocking
 * the others.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GraphStore } from "../src/storage/graph-store.js";
import { dedupRelations } from "../src/engine/relation-dedup.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/sqlite/db.js";
import { SqliteGraphStore } from "../src/storage/sqlite/sqlite-stores.js";

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
let store: GraphStore;
let entA: string;
let entB: string;

const mk = (
  id: string,
  source: string,
  target: string,
  type: string,
  properties: Record<string, string>,
) => ({ id, source, target, type, properties, created_at: new Date().toISOString() });

function writeRelations(rows: unknown[]): void {
  fs.writeFileSync(path.join(dir, "graph", "relations.json"), JSON.stringify(rows));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-rel-dedup-"));
  fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
  store = new GraphStore(dir);
  const a = await store.addEntity({ name: "src/a.ts", type: "file" });
  const b = await store.addEntity({ name: "D1", type: "concept" });
  entA = a.id;
  entB = b.id;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dedupRelations", () => {
  beforeEach(async () => {
    const c = await store.addEntity({ name: "D2", type: "concept" });
    // Manufacture pre-upsert duplicates directly (the API can no longer create them).
    writeRelations([
      mk("R1", entA, entB, "decided_by", { origin: "declared", note: "first" }),
      mk("R2", entA, entB, "decided_by", { origin: "derived", extra: "second" }),
      mk("R3", entA, entB, "decided_by", { extra: "third", other: "x" }),
      mk("R4", entA, c.id, "decided_by", { note: "distinct" }),
    ]);
  });

  it("preview counts duplicate groups without mutating", async () => {
    const report = await dedupRelations(store, false);
    expect(report.duplicate_groups).toBe(1);
    expect(report.duplicate_relations).toBe(2);
    expect(report.removed).toBe(0);
    expect(report.skipped_id_collisions).toBe(0);
    expect(report.failed_groups).toBe(0);
    expect(report.errors).toEqual([]);
    expect((await store.getRelations())).toHaveLength(4);
  });

  it("execute keeps the oldest, folds properties with origin precedence, removes the rest", async () => {
    const report = await dedupRelations(store, true);
    expect(report.removed).toBe(2);
    const relations = await store.getRelations();
    expect(relations).toHaveLength(2);
    const survivor = relations.find((r) => r.id === "R1")!;
    // Later duplicates' properties folded in; declared origin never downgraded.
    expect(survivor.properties).toEqual({
      origin: "declared",
      note: "first",
      extra: "third",
      other: "x",
    });
    expect(relations.some((r) => r.id === "R4")).toBe(true);
  });
});

describe("dedupRelations id-collision safety", () => {
  it("skips exact-duplicate rows and cross-key shared ids, never over-deleting", async () => {
    const c = await store.addEntity({ name: "D2", type: "concept" });
    writeRelations([
      mk("D1", entA, entB, "decided_by", { note: "first" }),
      // Exact-duplicate row (same id, same key): a union-style git merge of
      // relations.json can leave the same row twice. Removal by id would
      // delete the survivor too.
      mk("D1", entA, entB, "decided_by", { extra: "copy" }),
      // Cross-key shared id: removal by id would delete the (a, c) edge.
      mk("RX", entA, entB, "decided_by", { p: "q" }),
      mk("RX", entA, c.id, "decided_by", { keep: "me" }),
      mk("R2", entA, entB, "decided_by", { other: "x" }),
    ]);

    const preview = await dedupRelations(store, false);
    expect(preview.duplicate_groups).toBe(1);
    expect(preview.duplicate_relations).toBe(3);
    expect(preview.skipped_id_collisions).toBe(2);
    expect((await store.getRelations())).toHaveLength(5);

    const report = await dedupRelations(store, true);
    expect(report.removed).toBe(1);
    expect(report.skipped_id_collisions).toBe(2);
    expect(report.failed_groups).toBe(0);

    const relations = await store.getRelations();
    expect(relations).toHaveLength(4);
    expect(relations.some((r) => r.id === "R2")).toBe(false);
    // Both copies of the survivor row remain, the first carrying the fold.
    const d1 = relations.filter((r) => r.id === "D1");
    expect(d1).toHaveLength(2);
    expect(d1[0]!.properties).toEqual({
      note: "first",
      extra: "copy",
      p: "q",
      other: "x",
    });
    // The unrelated edge sharing id RX is untouched.
    const rxC = relations.find((r) => r.id === "RX" && r.target === c.id)!;
    expect(rxC.properties).toEqual({ keep: "me" });
  });
});

describe("dedupRelations per-group error isolation", () => {
  it("skips a group whose endpoints no longer resolve without blocking the rest", async () => {
    writeRelations([
      // Dangling group first: its failure must not abort the valid group below.
      mk("G1", "GHOST", entB, "decided_by", { a: "1" }),
      mk("G2", "GHOST", entB, "decided_by", { b: "2" }),
      mk("V1", entA, entB, "decided_by", { note: "first" }),
      mk("V2", entA, entB, "decided_by", { extra: "second" }),
    ]);

    const preview = await dedupRelations(store, false);
    expect(preview.duplicate_groups).toBe(2);
    expect(preview.failed_groups).toBe(0);

    const report = await dedupRelations(store, true);
    expect(report.failed_groups).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/Entity not found/);
    expect(report.removed).toBe(1);

    const relations = await store.getRelations();
    expect(relations).toHaveLength(3);
    // Dangling group left untouched; valid group deduped.
    expect(relations.filter((r) => r.source === "GHOST")).toHaveLength(2);
    expect(relations.some((r) => r.id === "V2")).toBe(false);
    expect(relations.find((r) => r.id === "V1")!.properties).toEqual({
      note: "first",
      extra: "second",
    });
  });
});

describe.skipIf(!HAS_SQLITE)("dedupRelations sqlite parity", () => {
  let sqliteDir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-rel-dedup-sql-"));
    db = openDatabase(sqliteDir);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    fs.rmSync(sqliteDir, { recursive: true, force: true });
  });

  it("merges into the seq-first edge and removes later duplicates", async () => {
    const sqlStore = new SqliteGraphStore(db);
    const a = await sqlStore.addEntity({ name: "src/a.ts", type: "file" });
    const b = await sqlStore.addEntity({ name: "D1", type: "concept" });
    const c = await sqlStore.addEntity({ name: "D2", type: "concept" });
    // Manufacture pre-upsert duplicates directly (the API can no longer create them).
    const ins = db.prepare(
      "INSERT INTO relations (id, source, target, data) VALUES (?, ?, ?, ?)",
    );
    for (const row of [
      mk("S1", a.id, b.id, "decided_by", { origin: "declared", note: "first" }),
      mk("S2", a.id, b.id, "decided_by", { origin: "derived", extra: "second" }),
      mk("S3", a.id, b.id, "decided_by", { extra: "third", other: "x" }),
      mk("S4", a.id, c.id, "decided_by", { note: "distinct" }),
    ]) {
      ins.run(row.id, row.source, row.target, JSON.stringify(row));
    }

    const preview = await dedupRelations(sqlStore, false);
    expect(preview.duplicate_groups).toBe(1);
    expect(preview.duplicate_relations).toBe(2);
    expect(preview.removed).toBe(0);
    expect((await sqlStore.getRelations())).toHaveLength(4);

    const report = await dedupRelations(sqlStore, true);
    expect(report.removed).toBe(2);
    const relations = await sqlStore.getRelations();
    expect(relations).toHaveLength(2);
    // Survivor is the seq-first edge — the row live upserts merge into.
    expect(relations[0]!.id).toBe("S1");
    expect(relations[0]!.properties).toEqual({
      origin: "declared",
      note: "first",
      extra: "third",
      other: "x",
    });
    expect(relations.some((r) => r.id === "S4")).toBe(true);
  });
});
