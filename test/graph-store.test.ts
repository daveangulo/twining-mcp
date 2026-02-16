import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GraphStore } from "../src/storage/graph-store.js";
import { TwiningError } from "../src/utils/errors.js";

let tmpDir: string;
let store: GraphStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-graph-store-test-"));
  store = new GraphStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GraphStore.addEntity", () => {
  it("creates a new entity with generated ID and timestamps", async () => {
    const entity = await store.addEntity({
      name: "AuthService",
      type: "class",
      properties: { language: "typescript" },
    });

    expect(entity.id).toHaveLength(26); // ULID length
    expect(entity.name).toBe("AuthService");
    expect(entity.type).toBe("class");
    expect(entity.properties.language).toBe("typescript");
    expect(entity.created_at).toBeTruthy();
    expect(entity.updated_at).toBeTruthy();
  });

  it("upserts an existing entity (same name+type) by merging properties", async () => {
    const first = await store.addEntity({
      name: "AuthService",
      type: "class",
      properties: { language: "typescript" },
    });

    const second = await store.addEntity({
      name: "AuthService",
      type: "class",
      properties: { framework: "express" },
    });

    // Same ID — it was an update
    expect(second.id).toBe(first.id);
    // Properties merged
    expect(second.properties.language).toBe("typescript");
    expect(second.properties.framework).toBe("express");
    // updated_at changed
    expect(second.updated_at).toBeTruthy();
  });

  it("creates a new entity when name is same but type differs", async () => {
    const classEntity = await store.addEntity({
      name: "auth",
      type: "class",
    });
    const moduleEntity = await store.addEntity({
      name: "auth",
      type: "module",
    });

    expect(classEntity.id).not.toBe(moduleEntity.id);
    const entities = await store.getEntities();
    expect(entities).toHaveLength(2);
  });

  it("defaults properties to empty object", async () => {
    const entity = await store.addEntity({
      name: "utils",
      type: "module",
    });
    expect(entity.properties).toEqual({});
  });
});

describe("GraphStore.addRelation", () => {
  it("creates a relation by entity IDs", async () => {
    const source = await store.addEntity({ name: "A", type: "class" });
    const target = await store.addEntity({ name: "B", type: "class" });

    const relation = await store.addRelation({
      source: source.id,
      target: target.id,
      type: "depends_on",
    });

    expect(relation.id).toHaveLength(26);
    expect(relation.source).toBe(source.id);
    expect(relation.target).toBe(target.id);
    expect(relation.type).toBe("depends_on");
    expect(relation.created_at).toBeTruthy();
  });

  it("resolves entities by name (unique names)", async () => {
    await store.addEntity({ name: "AuthService", type: "class" });
    await store.addEntity({ name: "UserService", type: "class" });

    const relation = await store.addRelation({
      source: "AuthService",
      target: "UserService",
      type: "calls",
    });

    expect(relation.source).toBeTruthy();
    expect(relation.target).toBeTruthy();
    expect(relation.type).toBe("calls");
  });

  it("throws AMBIGUOUS_ENTITY when name matches multiple entities", async () => {
    await store.addEntity({ name: "auth", type: "class" });
    await store.addEntity({ name: "auth", type: "module" });

    await expect(
      store.addRelation({
        source: "auth",
        target: "auth",
        type: "related_to",
      }),
    ).rejects.toThrow(TwiningError);

    try {
      await store.addRelation({
        source: "auth",
        target: "auth",
        type: "related_to",
      });
    } catch (e) {
      expect((e as TwiningError).code).toBe("AMBIGUOUS_ENTITY");
    }
  });

  it("throws NOT_FOUND for missing entity", async () => {
    await store.addEntity({ name: "A", type: "class" });

    await expect(
      store.addRelation({
        source: "A",
        target: "NonExistent",
        type: "depends_on",
      }),
    ).rejects.toThrow(TwiningError);

    try {
      await store.addRelation({
        source: "A",
        target: "NonExistent",
        type: "depends_on",
      });
    } catch (e) {
      expect((e as TwiningError).code).toBe("NOT_FOUND");
    }
  });

  it("prefers ID resolution over name resolution", async () => {
    const entityA = await store.addEntity({ name: "A", type: "class" });
    const entityB = await store.addEntity({ name: "B", type: "class" });

    // Use ID for source and name for target
    const relation = await store.addRelation({
      source: entityA.id,
      target: "B",
      type: "depends_on",
    });

    expect(relation.source).toBe(entityA.id);
    expect(relation.target).toBe(entityB.id);
  });

  it("stores relation properties", async () => {
    const a = await store.addEntity({ name: "A", type: "class" });
    const b = await store.addEntity({ name: "B", type: "class" });

    const relation = await store.addRelation({
      source: a.id,
      target: b.id,
      type: "implements",
      properties: { version: "2.0" },
    });

    expect(relation.properties.version).toBe("2.0");
  });
});

describe("GraphStore.getEntities / getRelations", () => {
  it("returns empty array if files don't exist", async () => {
    // Don't add anything — files may or may not exist
    const freshStore = new GraphStore(
      fs.mkdtempSync(path.join(os.tmpdir(), "twining-graph-empty-")),
    );
    const entities = await freshStore.getEntities();
    const relations = await freshStore.getRelations();
    expect(entities).toEqual([]);
    expect(relations).toEqual([]);
  });

  it("returns all stored entities", async () => {
    await store.addEntity({ name: "A", type: "class" });
    await store.addEntity({ name: "B", type: "function" });
    const entities = await store.getEntities();
    expect(entities).toHaveLength(2);
  });

  it("returns all stored relations", async () => {
    const a = await store.addEntity({ name: "A", type: "class" });
    const b = await store.addEntity({ name: "B", type: "class" });
    await store.addRelation({ source: a.id, target: b.id, type: "calls" });
    const relations = await store.getRelations();
    expect(relations).toHaveLength(1);
  });
});

describe("GraphStore.getEntityById / getEntityByName", () => {
  it("finds entity by ID", async () => {
    const entity = await store.addEntity({ name: "Test", type: "module" });
    const found = await store.getEntityById(entity.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Test");
  });

  it("returns undefined for non-existent ID", async () => {
    const found = await store.getEntityById("NONEXISTENT0000000000000000");
    expect(found).toBeUndefined();
  });

  it("finds entities by name", async () => {
    await store.addEntity({ name: "auth", type: "class" });
    await store.addEntity({ name: "auth", type: "module" });
    const found = await store.getEntityByName("auth");
    expect(found).toHaveLength(2);
  });

  it("filters by type when provided", async () => {
    await store.addEntity({ name: "auth", type: "class" });
    await store.addEntity({ name: "auth", type: "module" });
    const found = await store.getEntityByName("auth", "class");
    expect(found).toHaveLength(1);
    expect(found[0]!.type).toBe("class");
  });

  it("returns empty array for non-matching name", async () => {
    const found = await store.getEntityByName("nonexistent");
    expect(found).toEqual([]);
  });
});
