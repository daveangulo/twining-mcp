// test/migrate/auto.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { maybeAutoMigrate } from "../../src/migrate/auto.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

let root: string;
let twiningDir: string;

function writeLegacyProject(): void {
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.writeFileSync(
    path.join(twiningDir, "blackboard.jsonl"),
    JSON.stringify({
      id: "01HTESTENTRY0000000000000A",
      timestamp: "2026-07-01T00:00:00.000Z",
      agent_id: "test",
      entry_type: "finding",
      scope: "project",
      summary: "legacy entry",
      detail: "",
      tags: [],
    }) + "\n",
  );
  // file DecisionStore precondition (matches forward.test.ts convention)
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "decisions", "index.json"), "[]");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "twining-automigrate-"));
  twiningDir = path.join(root, ".twining");
  delete process.env.TWINING_AUTO_MIGRATE;
});

afterEach(() => {
  delete process.env.TWINING_AUTO_MIGRATE;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("maybeAutoMigrate", () => {
  it("is a no-op without opt-in (nudge-only default)", async () => {
    writeLegacyProject();
    await maybeAutoMigrate(root);
    expect(fs.existsSync(path.join(twiningDir, "twining.db"))).toBe(false);
    expect(fs.existsSync(path.join(twiningDir, "records"))).toBe(false);
  });

  it("is a no-op when .twining/ does not exist", async () => {
    process.env.TWINING_AUTO_MIGRATE = "1";
    await expect(maybeAutoMigrate(root)).resolves.toBeUndefined();
    expect(fs.existsSync(twiningDir)).toBe(false);
  });

  it("respects an explicit backend choice even when opted in", async () => {
    writeLegacyProject();
    fs.writeFileSync(
      path.join(twiningDir, "config.yml"),
      "storage:\n  backend: files\n",
    );
    process.env.TWINING_AUTO_MIGRATE = "1";
    await maybeAutoMigrate(root);
    expect(fs.existsSync(path.join(twiningDir, "twining.db"))).toBe(false);
  });

  it("is a no-op on a fresh project even when opted in (nothing to migrate)", async () => {
    fs.mkdirSync(twiningDir, { recursive: true });
    process.env.TWINING_AUTO_MIGRATE = "1";
    await maybeAutoMigrate(root);
    expect(fs.existsSync(path.join(twiningDir, "twining.db"))).toBe(false);
  });

  it.runIf(HAS_SQLITE)(
    "migrates a legacy project when TWINING_AUTO_MIGRATE=1",
    async () => {
      writeLegacyProject();
      process.env.TWINING_AUTO_MIGRATE = "1";
      await maybeAutoMigrate(root);
      expect(fs.existsSync(path.join(twiningDir, "twining.db"))).toBe(true);
      const cfg = yaml.load(
        fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8"),
      ) as { version: number; storage: { backend: string } };
      expect(cfg.storage.backend).toBe("sqlite");
      expect(cfg.version).toBe(2);
    },
  );

  it.runIf(HAS_SQLITE)(
    "migrates when config.yml sets storage.auto_migrate: true",
    async () => {
      writeLegacyProject();
      fs.writeFileSync(
        path.join(twiningDir, "config.yml"),
        "storage:\n  auto_migrate: true\n",
      );
      await maybeAutoMigrate(root);
      expect(fs.existsSync(path.join(twiningDir, "twining.db"))).toBe(true);
    },
  );

  it.runIf(HAS_SQLITE)(
    "is idempotent across sessions: second start is a no-op (sqlite state wins)",
    async () => {
      writeLegacyProject();
      process.env.TWINING_AUTO_MIGRATE = "1";
      await maybeAutoMigrate(root);
      // Second call: backend is now explicitly sqlite → early return.
      await expect(maybeAutoMigrate(root)).resolves.toBeUndefined();
    },
  );
});
