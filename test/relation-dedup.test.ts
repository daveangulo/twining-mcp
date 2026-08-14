/**
 * Legacy duplicate-relation dedup (wave-2 follow-up): field stores hold
 * pre-upsert duplicate (source, target, type) edges; the upsert only
 * prevents new ones and merges into the oldest. This pass removes the rest,
 * folding properties into the survivor under the origin-precedence rule.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GraphStore } from "../src/storage/graph-store.js";
import { dedupRelations } from "../src/engine/relation-dedup.js";

let dir: string;
let store: GraphStore;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-rel-dedup-"));
  fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
  store = new GraphStore(dir);
  const a = await store.addEntity({ name: "src/a.ts", type: "file" });
  const b = await store.addEntity({ name: "D1", type: "concept" });
  const c = await store.addEntity({ name: "D2", type: "concept" });
  // Manufacture pre-upsert duplicates directly (the API can no longer create them).
  const mk = (id: string, source: string, target: string, type: string, properties: Record<string, string>) => ({
    id, source, target, type, properties, created_at: new Date().toISOString(),
  });
  fs.writeFileSync(
    path.join(dir, "graph", "relations.json"),
    JSON.stringify([
      mk("R1", a.id, b.id, "decided_by", { origin: "declared", note: "first" }),
      mk("R2", a.id, b.id, "decided_by", { origin: "derived", extra: "second" }),
      mk("R3", a.id, b.id, "decided_by", { extra: "third", other: "x" }),
      mk("R4", a.id, c.id, "decided_by", { note: "distinct" }),
    ]),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dedupRelations", () => {
  it("preview counts duplicate groups without mutating", async () => {
    const report = await dedupRelations(store, false);
    expect(report.duplicate_groups).toBe(1);
    expect(report.duplicate_relations).toBe(2);
    expect(report.removed).toBe(0);
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
