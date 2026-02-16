import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { generateId } from "../src/utils/ids.js";
import { estimateTokens } from "../src/utils/tokens.js";
import { toolResult, toolError, TwiningError } from "../src/utils/errors.js";
import { ENTRY_TYPES } from "../src/utils/types.js";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

describe("generateId", () => {
  it("returns a 26-character string", () => {
    const id = generateId();
    expect(id).toHaveLength(26);
    expect(typeof id).toBe("string");
  });

  it("produces different IDs on successive calls", () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  it("produces lexicographically sortable IDs", () => {
    const id1 = generateId();
    // Small delay to ensure different timestamp component
    const id2 = generateId();
    expect(id1 < id2).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for 'test' (4 chars)", () => {
    expect(estimateTokens("test")).toBe(1);
  });

  it("returns 25 for a 100-character string", () => {
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it("rounds up for non-multiples of 4", () => {
    expect(estimateTokens("abc")).toBe(1); // 3/4 = 0.75 -> ceil = 1
    expect(estimateTokens("abcde")).toBe(2); // 5/4 = 1.25 -> ceil = 2
  });
});

describe("toolResult", () => {
  it("returns MCP content format", () => {
    const result = toolResult({ id: "abc", timestamp: "2024-01-01" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual({ id: "abc", timestamp: "2024-01-01" });
  });
});

describe("toolError", () => {
  it("returns error format with code", () => {
    const result = toolError("Something failed", "FILE_WRITE_ERROR");
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual({
      error: true,
      message: "Something failed",
      code: "FILE_WRITE_ERROR",
    });
  });
});

describe("TwiningError", () => {
  it("extends Error with code property", () => {
    const err = new TwiningError("bad input", "INVALID_INPUT");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("bad input");
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.name).toBe("TwiningError");
  });
});

describe("ENTRY_TYPES", () => {
  it("contains exactly 10 entry types", () => {
    expect(ENTRY_TYPES).toHaveLength(10);
  });

  it("includes all required types", () => {
    const expected = [
      "need",
      "offer",
      "finding",
      "decision",
      "constraint",
      "question",
      "answer",
      "status",
      "artifact",
      "warning",
    ];
    expect([...ENTRY_TYPES]).toEqual(expected);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when config file is missing", () => {
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(1);
    expect(config.embedding_model).toBe("all-MiniLM-L6-v2");
    expect(config.archive.max_blackboard_entries_before_archive).toBe(500);
    expect(config.context_assembly.default_max_tokens).toBe(4000);
    expect(config.conflict_resolution).toBe("human");
  });

  it("merges partial config with defaults", () => {
    const partial = {
      project_name: "my-project",
      archive: {
        max_blackboard_entries_before_archive: 100,
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.yml"), yaml.dump(partial));
    const config = loadConfig(tmpDir);
    expect(config.project_name).toBe("my-project");
    expect(config.archive.max_blackboard_entries_before_archive).toBe(100);
    // Defaults preserved
    expect(config.archive.auto_archive_on_commit).toBe(true);
    expect(config.context_assembly.default_max_tokens).toBe(4000);
    expect(config.embedding_model).toBe("all-MiniLM-L6-v2");
  });

  it("preserves nested defaults when partial nested config provided", () => {
    const partial = {
      context_assembly: {
        default_max_tokens: 8000,
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.yml"), yaml.dump(partial));
    const config = loadConfig(tmpDir);
    expect(config.context_assembly.default_max_tokens).toBe(8000);
    expect(config.context_assembly.priority_weights.recency).toBe(0.3);
    expect(config.context_assembly.priority_weights.relevance).toBe(0.4);
  });
});
