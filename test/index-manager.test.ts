/**
 * Tests for the IndexManager class.
 * Uses temp directories for isolation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { IndexManager } from "../src/embeddings/index-manager.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-index-manager-test-"),
  );
  return dir;
}

describe("IndexManager", () => {
  let tmpDir: string;
  let manager: IndexManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    manager = new IndexManager(tmpDir);
  });

  describe("load", () => {
    it("should return empty index when file does not exist", async () => {
      const index = await manager.load("blackboard");
      expect(index.model).toBe("all-MiniLM-L6-v2");
      expect(index.dimension).toBe(384);
      expect(index.entries).toHaveLength(0);
    });

    it("should return empty index when file is empty", async () => {
      const filePath = path.join(tmpDir, "embeddings", "blackboard.index");
      fs.writeFileSync(filePath, "");
      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(0);
    });

    it("should load existing index", async () => {
      const testIndex = {
        model: "all-MiniLM-L6-v2",
        dimension: 384,
        entries: [{ id: "test-1", vector: [0.1, 0.2, 0.3] }],
      };
      const filePath = path.join(tmpDir, "embeddings", "blackboard.index");
      fs.writeFileSync(filePath, JSON.stringify(testIndex));

      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]!.id).toBe("test-1");
      expect(index.entries[0]!.vector).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("save", () => {
    it("should write index to file", async () => {
      const testIndex = {
        model: "all-MiniLM-L6-v2",
        dimension: 384,
        entries: [{ id: "test-1", vector: [0.5, 0.6, 0.7] }],
      };

      await manager.save("blackboard", testIndex);

      const filePath = path.join(tmpDir, "embeddings", "blackboard.index");
      const content = fs.readFileSync(filePath, "utf-8");
      const loaded = JSON.parse(content);
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0].id).toBe("test-1");
    });
  });

  describe("addEntry", () => {
    it("should add entry to empty index", async () => {
      await manager.addEntry("blackboard", "entry-1", [0.1, 0.2, 0.3]);

      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]!.id).toBe("entry-1");
      expect(index.entries[0]!.vector).toEqual([0.1, 0.2, 0.3]);
    });

    it("should add multiple entries", async () => {
      await manager.addEntry("blackboard", "entry-1", [0.1, 0.2, 0.3]);
      await manager.addEntry("blackboard", "entry-2", [0.4, 0.5, 0.6]);

      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(2);
    });

    it("should replace existing entry with same ID", async () => {
      await manager.addEntry("blackboard", "entry-1", [0.1, 0.2, 0.3]);
      await manager.addEntry("blackboard", "entry-1", [0.9, 0.8, 0.7]);

      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]!.vector).toEqual([0.9, 0.8, 0.7]);
    });

    it("should handle concurrent addEntry calls without corruption", async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          manager.addEntry("blackboard", `entry-${i}`, [i * 0.1, i * 0.2]),
        );
      }
      await Promise.all(promises);

      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(10);
    });

    it("should work with decisions index", async () => {
      await manager.addEntry("decisions", "dec-1", [0.1, 0.2]);
      const index = await manager.load("decisions");
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]!.id).toBe("dec-1");
    });
  });

  describe("removeEntries", () => {
    it("should remove entries by IDs", async () => {
      await manager.addEntry("blackboard", "entry-1", [0.1]);
      await manager.addEntry("blackboard", "entry-2", [0.2]);
      await manager.addEntry("blackboard", "entry-3", [0.3]);

      await manager.removeEntries("blackboard", ["entry-1", "entry-3"]);

      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]!.id).toBe("entry-2");
    });

    it("should be a no-op when file does not exist", async () => {
      // Should not throw
      await manager.removeEntries("blackboard", ["nonexistent"]);
    });

    it("should be a no-op when IDs do not match", async () => {
      await manager.addEntry("blackboard", "entry-1", [0.1]);
      await manager.removeEntries("blackboard", ["nonexistent"]);

      const index = await manager.load("blackboard");
      expect(index.entries).toHaveLength(1);
    });
  });

  describe("getVector", () => {
    it("should return vector for existing entry", async () => {
      await manager.addEntry("blackboard", "entry-1", [0.1, 0.2, 0.3]);
      const vector = await manager.getVector("blackboard", "entry-1");
      expect(vector).toEqual([0.1, 0.2, 0.3]);
    });

    it("should return null for non-existing entry", async () => {
      const vector = await manager.getVector("blackboard", "nonexistent");
      expect(vector).toBeNull();
    });
  });
});
