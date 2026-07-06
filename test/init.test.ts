import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { initTwiningDir, ensureInitialized } from "../src/storage/init.js";
import { sqliteAvailable } from "../src/storage/sqlite/db.js";
import { SUPPORTED_CONFIG_VERSION } from "../src/config.js";

describe("initTwiningDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-init-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fresh init stamps an explicit backend and matching format version", () => {
    initTwiningDir(tmpDir);
    const parsed = yaml.load(
      fs.readFileSync(path.join(tmpDir, ".twining", "config.yml"), "utf-8"),
    ) as { version: number; storage: { backend: string } };
    if (sqliteAvailable()) {
      expect(parsed.storage.backend).toBe("sqlite");
      expect(parsed.version).toBe(SUPPORTED_CONFIG_VERSION);
    } else {
      expect(parsed.storage.backend).toBe("files");
      expect(parsed.version).toBe(1);
    }
  });

  it("creates .twining/agents/ directory", () => {
    initTwiningDir(tmpDir);
    const agentsDir = path.join(tmpDir, ".twining", "agents");
    expect(fs.existsSync(agentsDir)).toBe(true);
    expect(fs.statSync(agentsDir).isDirectory()).toBe(true);
  });

  it("creates .twining/handoffs/ directory", () => {
    initTwiningDir(tmpDir);
    const handoffsDir = path.join(tmpDir, ".twining", "handoffs");
    expect(fs.existsSync(handoffsDir)).toBe(true);
    expect(fs.statSync(handoffsDir).isDirectory()).toBe(true);
  });

  it("creates .twining/agents/registry.json with empty array", () => {
    initTwiningDir(tmpDir);
    const registryPath = path.join(tmpDir, ".twining", "agents", "registry.json");
    expect(fs.existsSync(registryPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    expect(content).toEqual([]);
  });

  it("is idempotent -- calling twice does not error or overwrite", () => {
    initTwiningDir(tmpDir);

    // Write something to registry to verify it's not overwritten
    const registryPath = path.join(tmpDir, ".twining", "agents", "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([{ agent_id: "test" }], null, 2));

    // Second call should be a no-op (early return because .twining/ exists)
    initTwiningDir(tmpDir);

    const content = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    expect(content).toEqual([{ agent_id: "test" }]);
  });

  it("ensureInitialized returns the correct .twining path and creates all directories", () => {
    const twiningPath = ensureInitialized(tmpDir);
    expect(twiningPath).toBe(path.join(tmpDir, ".twining"));
    expect(fs.existsSync(path.join(twiningPath, "agents"))).toBe(true);
    expect(fs.existsSync(path.join(twiningPath, "handoffs"))).toBe(true);
    expect(fs.existsSync(path.join(twiningPath, "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(twiningPath, "graph"))).toBe(true);
    expect(fs.existsSync(path.join(twiningPath, "embeddings"))).toBe(true);
    expect(fs.existsSync(path.join(twiningPath, "archive"))).toBe(true);
  });
});
