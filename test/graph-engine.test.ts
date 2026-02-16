import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GraphStore } from "../src/storage/graph-store.js";
import { GraphEngine } from "../src/engine/graph.js";
import { TwiningError } from "../src/utils/errors.js";

let tmpDir: string;
let store: GraphStore;
let engine: GraphEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-graph-engine-test-"));
  store = new GraphStore(tmpDir);
  engine = new GraphEngine(store);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GraphEngine.neighbors", () => {
  it("returns direct neighbors at depth 1", async () => {
    const a = await engine.addEntity({ name: "A", type: "class" });
    const b = await engine.addEntity({ name: "B", type: "class" });
    const c = await engine.addEntity({ name: "C", type: "class" });
    await engine.addRelation({ source: a.id, target: b.id, type: "calls" });
    await engine.addRelation({ source: a.id, target: c.id, type: "depends_on" });

    const result = await engine.neighbors(a.id, 1);
    expect(result.center.id).toBe(a.id);
    expect(result.neighbors).toHaveLength(2);
    const neighborNames = result.neighbors.map((n) => n.entity.name).sort();
    expect(neighborNames).toEqual(["B", "C"]);
  });

  it("returns two-hop neighbors at depth 2", async () => {
    const a = await engine.addEntity({ name: "A", type: "class" });
    const b = await engine.addEntity({ name: "B", type: "class" });
    const c = await engine.addEntity({ name: "C", type: "class" });
    await engine.addRelation({ source: a.id, target: b.id, type: "calls" });
    await engine.addRelation({ source: b.id, target: c.id, type: "calls" });

    // Depth 1: only B
    const depth1 = await engine.neighbors(a.id, 1);
    expect(depth1.neighbors).toHaveLength(1);
    expect(depth1.neighbors[0]!.entity.name).toBe("B");

    // Depth 2: B and C
    const depth2 = await engine.neighbors(a.id, 2);
    expect(depth2.neighbors).toHaveLength(2);
    const names = depth2.neighbors.map((n) => n.entity.name).sort();
    expect(names).toEqual(["B", "C"]);
  });

  it("respects max depth of 3", async () => {
    const nodes = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(
        await engine.addEntity({ name: `N${i}`, type: "class" }),
      );
    }
    // Chain: N0 -> N1 -> N2 -> N3 -> N4
    for (let i = 0; i < 4; i++) {
      await engine.addRelation({
        source: nodes[i]!.id,
        target: nodes[i + 1]!.id,
        type: "calls",
      });
    }

    // Depth 5 should be clamped to 3, so we get N1, N2, N3 (not N4)
    const result = await engine.neighbors(nodes[0]!.id, 5);
    expect(result.neighbors).toHaveLength(3);
    const names = result.neighbors.map((n) => n.entity.name).sort();
    expect(names).toEqual(["N1", "N2", "N3"]);
  });

  it("filters by relation types", async () => {
    const a = await engine.addEntity({ name: "A", type: "class" });
    const b = await engine.addEntity({ name: "B", type: "class" });
    const c = await engine.addEntity({ name: "C", type: "class" });
    await engine.addRelation({ source: a.id, target: b.id, type: "calls" });
    await engine.addRelation({ source: a.id, target: c.id, type: "depends_on" });

    const result = await engine.neighbors(a.id, 1, ["calls"]);
    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0]!.entity.name).toBe("B");
    expect(result.neighbors[0]!.relation.type).toBe("calls");
  });

  it("handles cycles without infinite loop", async () => {
    const a = await engine.addEntity({ name: "A", type: "class" });
    const b = await engine.addEntity({ name: "B", type: "class" });
    const c = await engine.addEntity({ name: "C", type: "class" });
    // A -> B -> C -> A (cycle)
    await engine.addRelation({ source: a.id, target: b.id, type: "calls" });
    await engine.addRelation({ source: b.id, target: c.id, type: "calls" });
    await engine.addRelation({ source: c.id, target: a.id, type: "calls" });

    const result = await engine.neighbors(a.id, 3);
    // Should find B and C, but not revisit A
    expect(result.neighbors).toHaveLength(2);
    const names = result.neighbors.map((n) => n.entity.name).sort();
    expect(names).toEqual(["B", "C"]);
  });

  it("traverses both outgoing and incoming relations", async () => {
    const a = await engine.addEntity({ name: "A", type: "class" });
    const b = await engine.addEntity({ name: "B", type: "class" });
    const c = await engine.addEntity({ name: "C", type: "class" });
    // B -> A (A is target, so B is incoming neighbor of A)
    await engine.addRelation({ source: b.id, target: a.id, type: "calls" });
    // A -> C (outgoing)
    await engine.addRelation({ source: a.id, target: c.id, type: "depends_on" });

    const result = await engine.neighbors(a.id, 1);
    expect(result.neighbors).toHaveLength(2);
    const incoming = result.neighbors.find((n) => n.direction === "incoming");
    const outgoing = result.neighbors.find((n) => n.direction === "outgoing");
    expect(incoming!.entity.name).toBe("B");
    expect(outgoing!.entity.name).toBe("C");
  });

  it("resolves center by name", async () => {
    await engine.addEntity({ name: "MyService", type: "class" });
    const result = await engine.neighbors("MyService", 1);
    expect(result.center.name).toBe("MyService");
  });

  it("throws NOT_FOUND for non-existent entity", async () => {
    await expect(engine.neighbors("NonExistent", 1)).rejects.toThrow(
      TwiningError,
    );

    try {
      await engine.neighbors("NonExistent", 1);
    } catch (e) {
      expect((e as TwiningError).code).toBe("NOT_FOUND");
    }
  });

  it("defaults depth to 1", async () => {
    const a = await engine.addEntity({ name: "A", type: "class" });
    const b = await engine.addEntity({ name: "B", type: "class" });
    const c = await engine.addEntity({ name: "C", type: "class" });
    await engine.addRelation({ source: a.id, target: b.id, type: "calls" });
    await engine.addRelation({ source: b.id, target: c.id, type: "calls" });

    const result = await engine.neighbors(a.id);
    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0]!.entity.name).toBe("B");
  });
});

describe("GraphEngine.query", () => {
  it("matches entities by name substring (case-insensitive)", async () => {
    await engine.addEntity({ name: "AuthService", type: "class" });
    await engine.addEntity({ name: "UserService", type: "class" });
    await engine.addEntity({ name: "DatabaseHelper", type: "class" });

    const result = await engine.query("service");
    expect(result.entities).toHaveLength(2);
    const names = result.entities.map((e) => e.name).sort();
    expect(names).toEqual(["AuthService", "UserService"]);
  });

  it("matches entities by property value substring", async () => {
    await engine.addEntity({
      name: "AuthModule",
      type: "module",
      properties: { description: "Handles JWT authentication" },
    });
    await engine.addEntity({
      name: "DbModule",
      type: "module",
      properties: { description: "Database connection" },
    });

    const result = await engine.query("jwt");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe("AuthModule");
  });

  it("filters by entity types", async () => {
    await engine.addEntity({ name: "auth", type: "class" });
    await engine.addEntity({ name: "auth", type: "module" });
    await engine.addEntity({ name: "auth-func", type: "function" });

    const result = await engine.query("auth", ["class", "function"]);
    expect(result.entities).toHaveLength(2);
    const types = result.entities.map((e) => e.type).sort();
    expect(types).toEqual(["class", "function"]);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 20; i++) {
      await engine.addEntity({ name: `Item${i}`, type: "class" });
    }

    const result = await engine.query("Item", undefined, 5);
    expect(result.entities).toHaveLength(5);
  });

  it("defaults limit to 10", async () => {
    for (let i = 0; i < 15; i++) {
      await engine.addEntity({ name: `Item${i}`, type: "class" });
    }

    const result = await engine.query("Item");
    expect(result.entities).toHaveLength(10);
  });

  it("returns empty array for no matches", async () => {
    await engine.addEntity({ name: "AuthService", type: "class" });
    const result = await engine.query("nonexistent");
    expect(result.entities).toEqual([]);
  });
});
