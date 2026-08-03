/**
 * Graph entity scope accumulates instead of overwriting (deep review, 2026-07).
 *
 * The auto-populator stamps file and symbol entities with the scope of the
 * decision that touched them. Upsert merged properties last-writer-wins, so a
 * decision in another scope silently replaced the previous value — measured on
 * this repo at 110 of 242 scoped file entities carrying a scope their own path
 * did not start with, plus an entity rewrite (git churn) on every flip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../src/storage/graph-store.js";
import { GraphEngine } from "../src/engine/graph.js";
import { repairEntityScopes } from "../src/engine/entity-scope-repair.js";
import {
  joinSetProperty,
  mergeEntityProperties,
  splitSetProperty,
} from "../src/utils/entity-properties.js";

let dir: string;
let store: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-entity-scope-"));
  store = new GraphStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("scope accumulates across decisions in different scopes", () => {
  it("keeps both scopes when the same file is touched twice", async () => {
    const a = await store.addEntity({
      name: "docs/project-map.md",
      type: "file",
      properties: { scope: "analysis/" },
    });
    const b = await store.addEntity({
      name: "docs/project-map.md",
      type: "file",
      properties: { scope: "specs/cui-marking/" },
    });

    expect(b.id).toBe(a.id); // same entity, upserted
    const scopes = splitSetProperty(b.properties.scope);
    expect(scopes).toContain("analysis/");
    expect(scopes).toContain("specs/cui-marking/");
  });

  it("converges — the stored value stops changing once both scopes are known", async () => {
    const scopeOf = async () =>
      (await store.getEntities()).find((e) => e.name === "f.ts")!.properties.scope;

    await store.addEntity({ name: "f.ts", type: "file", properties: { scope: "a/" } });
    await store.addEntity({ name: "f.ts", type: "file", properties: { scope: "b/" } });
    const settled = await scopeOf();

    // The discriminating step: touching from a/ AGAIN. Under last-writer-wins
    // this flips the value back to "a/" — the oscillation that rewrote the
    // committed entity file on every decision. Under a union it is a no-op.
    await store.addEntity({ name: "f.ts", type: "file", properties: { scope: "a/" } });
    expect(await scopeOf()).toBe(settled);

    await store.addEntity({ name: "f.ts", type: "file", properties: { scope: "b/" } });
    expect(await scopeOf()).toBe(settled);
  });

  it("stores scopes sorted so byte-level output is deterministic", async () => {
    await store.addEntity({ name: "x.ts", type: "file", properties: { scope: "z/" } });
    const e = await store.addEntity({
      name: "x.ts",
      type: "file",
      properties: { scope: "a/" },
    });
    expect(e.properties.scope).toBe("a/,z/");
  });

  it("leaves non-set properties on last-writer-wins", () => {
    const merged = mergeEntityProperties(
      { scope: "a/", summary: "old" },
      { scope: "b/", summary: "new" },
    );
    expect(merged.summary).toBe("new");
    expect(splitSetProperty(merged.scope).sort()).toEqual(["a/", "b/"]);
  });

  it("caps growth so a hot entity cannot grow without bound", () => {
    const many = Array.from({ length: 40 }, (_, i) => `scope-${String(i).padStart(3, "0")}/`);
    const joined = joinSetProperty(many);
    expect(joined.length).toBeLessThanOrEqual(480);
    expect(splitSetProperty(joined).length).toBeLessThanOrEqual(12);
    // Capping is deterministic, so a capped entity still converges.
    expect(joinSetProperty(many)).toBe(joined);
  });
});

describe("repairEntityScopes recovers overwritten scopes", () => {
  /** Build the shape the auto-populator produces: file -decided_by-> decision. */
  async function seedOverwritten(): Promise<void> {
    const engine = new GraphEngine(store);
    for (const [decisionId, scope] of [
      ["dec-1", "analysis/"],
      ["dec-2", "specs/cui-marking/"],
    ] as const) {
      await engine.addEntity({
        name: decisionId,
        type: "concept",
        properties: { scope, summary: `decision in ${scope}` },
      });
      await engine.addRelation({
        source: "docs/project-map.md",
        target: decisionId,
        type: "decided_by",
      });
    }
  }

  it("unions the scopes of every decision that touched the entity", async () => {
    // Simulate a pre-fix entity: one scope only, though two decisions touched it.
    await store.addEntity({
      name: "docs/project-map.md",
      type: "file",
      properties: { scope: "specs/cui-marking/" },
    });
    await seedOverwritten();

    const preview = await repairEntityScopes(store, {});
    expect(preview.dry_run).toBe(true);
    expect(preview.repairable).toBeGreaterThanOrEqual(1);
    expect(preview.repaired).toBe(0);

    const target = preview.items.find((i) => i.entity === "docs/project-map.md");
    expect(target).toBeDefined();
    expect(splitSetProperty(target!.after).sort()).toEqual([
      "analysis/",
      "specs/cui-marking/",
    ]);

    // Preview must not have written anything.
    const [before] = (await store.getEntities()).filter(
      (e) => e.name === "docs/project-map.md",
    );
    expect(before.properties.scope).toBe("specs/cui-marking/");

    const applied = await repairEntityScopes(store, { execute: true });
    expect(applied.repaired).toBeGreaterThanOrEqual(1);

    const [after] = (await store.getEntities()).filter(
      (e) => e.name === "docs/project-map.md",
    );
    expect(splitSetProperty(after.properties.scope).sort()).toEqual([
      "analysis/",
      "specs/cui-marking/",
    ]);
  });

  it("is idempotent — a second run finds nothing to repair", async () => {
    await store.addEntity({
      name: "docs/project-map.md",
      type: "file",
      properties: { scope: "specs/cui-marking/" },
    });
    await seedOverwritten();
    await repairEntityScopes(store, { execute: true });

    const second = await repairEntityScopes(store, { execute: true });
    expect(second.repairable).toBe(0);
    expect(second.repaired).toBe(0);
  });

  it("never drops a stored scope that no relation accounts for", async () => {
    // A scope recorded by hand, with no decided_by edge backing it, is still a
    // real observation — repair must union, not replace.
    await store.addEntity({
      name: "orphan.ts",
      type: "file",
      properties: { scope: "hand-written/" },
    });
    const report = await repairEntityScopes(store, { execute: true });
    expect(report.repairable).toBe(0);
    const [e] = (await store.getEntities()).filter((x) => x.name === "orphan.ts");
    expect(e.properties.scope).toBe("hand-written/");
  });
});
