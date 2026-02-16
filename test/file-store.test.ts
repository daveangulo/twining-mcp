import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readJSON,
  writeJSON,
  appendJSONL,
  readJSONL,
} from "../src/storage/file-store.js";
import { initTwiningDir, ensureInitialized } from "../src/storage/init.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-fs-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeJSON + readJSON", () => {
  it("round-trips a JSON object", async () => {
    const filePath = path.join(tmpDir, "test.json");
    const data = { name: "test", value: 42, nested: { a: true } };
    await writeJSON(filePath, data);
    const result = await readJSON<typeof data>(filePath);
    expect(result).toEqual(data);
  });

  it("overwrites existing content", async () => {
    const filePath = path.join(tmpDir, "test.json");
    await writeJSON(filePath, { v: 1 });
    await writeJSON(filePath, { v: 2 });
    const result = await readJSON<{ v: number }>(filePath);
    expect(result.v).toBe(2);
  });
});

describe("appendJSONL + readJSONL", () => {
  it("round-trips multiple entries", async () => {
    const filePath = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(filePath, ""); // create empty file
    await appendJSONL(filePath, { id: 1, name: "first" });
    await appendJSONL(filePath, { id: 2, name: "second" });
    await appendJSONL(filePath, { id: 3, name: "third" });
    const results = await readJSONL<{ id: number; name: string }>(filePath);
    expect(results).toHaveLength(3);
    expect(results[0]!.id).toBe(1);
    expect(results[2]!.name).toBe("third");
  });

  it("skips corrupt lines gracefully", async () => {
    const filePath = path.join(tmpDir, "corrupt.jsonl");
    fs.writeFileSync(
      filePath,
      '{"valid":true}\nthis is not json\n{"also_valid":true}\n',
    );
    const results = await readJSONL<{ valid?: boolean; also_valid?: boolean }>(
      filePath,
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.valid).toBe(true);
    expect(results[1]!.also_valid).toBe(true);
  });

  it("returns empty array for non-existent file", async () => {
    const results = await readJSONL(path.join(tmpDir, "nope.jsonl"));
    expect(results).toEqual([]);
  });

  it("handles concurrent appends without corruption", async () => {
    const filePath = path.join(tmpDir, "concurrent.jsonl");
    fs.writeFileSync(filePath, "");

    // Fire 10 concurrent appends
    const promises = Array.from({ length: 10 }, (_, i) =>
      appendJSONL(filePath, { index: i }),
    );
    await Promise.all(promises);

    const results = await readJSONL<{ index: number }>(filePath);
    expect(results).toHaveLength(10);

    // All indices should be present (order may vary)
    const indices = results.map((r) => r.index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("initTwiningDir", () => {
  it("creates correct directory structure", () => {
    initTwiningDir(tmpDir);
    const twiningDir = path.join(tmpDir, ".twining");

    expect(fs.existsSync(twiningDir)).toBe(true);
    expect(fs.existsSync(path.join(twiningDir, "config.yml"))).toBe(true);
    expect(fs.existsSync(path.join(twiningDir, "blackboard.jsonl"))).toBe(true);
    expect(
      fs.existsSync(path.join(twiningDir, "decisions", "index.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(twiningDir, "graph", "entities.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(twiningDir, "graph", "relations.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(twiningDir, "embeddings"))).toBe(true);
    expect(fs.existsSync(path.join(twiningDir, "archive"))).toBe(true);
    expect(fs.existsSync(path.join(twiningDir, ".gitignore"))).toBe(true);
  });

  it("creates valid config.yml with project name", () => {
    initTwiningDir(tmpDir);
    const configContent = fs.readFileSync(
      path.join(tmpDir, ".twining", "config.yml"),
      "utf-8",
    );
    expect(configContent).toContain("version: 1");
    expect(configContent).toContain(`project_name: ${path.basename(tmpDir)}`);
    expect(configContent).toContain("embedding_model: all-MiniLM-L6-v2");
  });

  it("creates correct gitignore", () => {
    initTwiningDir(tmpDir);
    const gitignore = fs.readFileSync(
      path.join(tmpDir, ".twining", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("embeddings/*.index");
    expect(gitignore).toContain("archive/");
  });

  it("creates empty decision index as JSON array", () => {
    initTwiningDir(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".twining", "decisions", "index.json"),
        "utf-8",
      ),
    );
    expect(Array.isArray(index)).toBe(true);
    expect(index).toHaveLength(0);
  });

  it("is idempotent — calling twice doesn't error or overwrite", () => {
    initTwiningDir(tmpDir);
    // Write something to blackboard to verify it's not overwritten
    fs.writeFileSync(
      path.join(tmpDir, ".twining", "blackboard.jsonl"),
      '{"test":true}\n',
    );
    initTwiningDir(tmpDir); // Second call
    const content = fs.readFileSync(
      path.join(tmpDir, ".twining", "blackboard.jsonl"),
      "utf-8",
    );
    expect(content).toBe('{"test":true}\n'); // Not overwritten
  });
});

describe("ensureInitialized", () => {
  it("returns the .twining/ path", () => {
    const result = ensureInitialized(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".twining"));
    expect(fs.existsSync(result)).toBe(true);
  });
});
