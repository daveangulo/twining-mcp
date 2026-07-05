import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAutoBackend } from "../src/storage/backend-resolve.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-resolve-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveAutoBackend", () => {
  it("fresh project (empty dir) → sqlite", () => {
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "fresh" });
  });

  it("fresh project with only empty scaffold files → sqlite", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
    fs.mkdirSync(path.join(dir, "graph"));
    fs.writeFileSync(path.join(dir, "graph", "entities.json"), "[]");
    fs.writeFileSync(path.join(dir, "graph", "relations.json"), "[]");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "fresh" });
  });

  it("twining.db present → sqlite (already migrated)", () => {
    fs.writeFileSync(path.join(dir, "twining.db"), "");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "sqlite-state" });
  });

  it("records/ tree with any record file → sqlite", () => {
    fs.mkdirSync(path.join(dir, "records", "posts", "2026-07"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "records", "posts", "2026-07", "01ABC.json"),
      "{}",
    );
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "sqlite-state" });
  });

  it("empty records/ directories alone do NOT count as sqlite state", () => {
    fs.mkdirSync(path.join(dir, "records", "posts"), { recursive: true });
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "fresh" });
  });

  it("non-empty blackboard.jsonl and no sqlite state → files", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("non-trivial decisions index and no sqlite state → files", () => {
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), '[{"id":"01X"}]');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("stray decision file with empty index → files (index-desync salvage)", () => {
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
    fs.writeFileSync(path.join(dir, "decisions", "01ORPHAN.json"), "{}");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("non-empty graph entities and no sqlite state → files", () => {
    fs.mkdirSync(path.join(dir, "graph"));
    fs.writeFileSync(path.join(dir, "graph", "entities.json"), '[{"id":"e1"}]');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("malformed legacy file → files (ambiguity lands on the safe branch)", () => {
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), "{not json");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("sqlite state wins over legacy content (post-migration repos have both)", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
    fs.writeFileSync(path.join(dir, "twining.db"), "");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "sqlite-state" });
  });
});
