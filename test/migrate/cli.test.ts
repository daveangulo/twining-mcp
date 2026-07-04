// test/migrate/cli.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { runMigrateCli } from "../../src/migrate/cli.js";
import { createStores } from "../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

let projectRoot: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cli-"));
  const twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "decisions", "index.json"), "[]");
  fs.writeFileSync(path.join(twiningDir, "config.yml"), yaml.dump({ version: 1 }));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

async function seedOnePost() {
  const stores = createStores(path.join(projectRoot, ".twining"), { ...DEFAULT_CONFIG });
  await stores.blackboardStore.append({
    entry_type: "finding", summary: "cli seed", detail: "", tags: [], scope: "src/", agent_id: "m",
  });
}

describe.skipIf(!HAS_SQLITE)("runMigrateCli", () => {
  it("migrates forward and exits 0, printing the report and next steps", async () => {
    await seedOnePost();
    const code = await runMigrateCli(["--project", projectRoot]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/posts:\s*1/);
    expect(out).toMatch(/storage\.backend → sqlite/);
    expect(out).toMatch(/git add/); // prints commit guidance, never auto-commits
    expect(out).toMatch(/stop any running/i);
  });

  it("--dry-run exits 0 and changes nothing", async () => {
    await seedOnePost();
    const code = await runMigrateCli(["--project", projectRoot, "--dry-run"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/dry-run: nothing written/);
    expect(fs.existsSync(path.join(projectRoot, ".twining", "twining.db"))).toBe(false);
  });

  it("--check exits 0 after a migration and 1 when the db is gone", async () => {
    await seedOnePost();
    await runMigrateCli(["--project", projectRoot]);
    expect(await runMigrateCli(["--project", projectRoot, "--check"])).toBe(0);
    expect(logs.join("\n")).toMatch(/check passed/);

    for (const f of ["twining.db", "twining.db-wal", "twining.db-shm"]) {
      fs.rmSync(path.join(projectRoot, ".twining", f), { force: true });
    }
    expect(await runMigrateCli(["--project", projectRoot, "--check"])).toBe(1);
    expect(logs.join("\n")).toMatch(/not migrated/);
  });

  it("--reverse round-trips back to the file backend and prints the FROZEN warning", async () => {
    await seedOnePost();
    await runMigrateCli(["--project", projectRoot]);
    const code = await runMigrateCli(["--project", projectRoot, "--reverse"]);
    expect(code).toBe(0);
    const cfg = yaml.load(
      fs.readFileSync(path.join(projectRoot, ".twining", "config.yml"), "utf-8"),
    ) as { storage: { backend: string } };
    expect(cfg.storage.backend).toBe("files");
    expect(logs.join("\n")).toMatch(/FROZEN/);
  });

  it("exits 2 on usage and environment errors, with the message on stderr", async () => {
    expect(await runMigrateCli(["--bogus-flag"])).toBe(2);
    expect(errors.join("\n")).toMatch(/unknown argument.*--bogus-flag/s);
    expect(errors.join("\n")).toMatch(/usage:/);

    fs.rmSync(path.join(projectRoot, ".twining"), { recursive: true, force: true });
    expect(await runMigrateCli(["--project", projectRoot])).toBe(2);
    expect(errors.join("\n")).toMatch(/no \.twining/);
  });

  it("--reverse --check is a usage error and touches nothing", async () => {
    await seedOnePost();
    await runMigrateCli(["--project", projectRoot]); // forward: backend now sqlite
    const code = await runMigrateCli(["--project", projectRoot, "--reverse", "--check"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/not supported with --reverse/);
    expect(errors.join("\n")).toMatch(/usage:/);
    const cfg = yaml.load(
      fs.readFileSync(path.join(projectRoot, ".twining", "config.yml"), "utf-8"),
    ) as { storage: { backend: string } };
    expect(cfg.storage.backend).toBe("sqlite"); // no real reverse ran
  });

  it("--dry-run --check is a usage error", async () => {
    const code = await runMigrateCli(["--project", projectRoot, "--dry-run", "--check"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/mutually exclusive/);
    expect(errors.join("\n")).toMatch(/usage:/);
  });

  it("--project without a value is a usage error", async () => {
    const code = await runMigrateCli(["--project"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/missing value/);
    expect(errors.join("\n")).toMatch(/usage:/);
  });

  it("--reverse --dry-run exits 0 and changes nothing", async () => {
    await seedOnePost();
    await runMigrateCli(["--project", projectRoot]); // forward: backend now sqlite
    const code = await runMigrateCli(["--project", projectRoot, "--reverse", "--dry-run"]);
    expect(code).toBe(0);
    const cfg = yaml.load(
      fs.readFileSync(path.join(projectRoot, ".twining", "config.yml"), "utf-8"),
    ) as { storage: { backend: string } };
    expect(cfg.storage.backend).toBe("sqlite"); // dry-run did not flip it back
    expect(fs.existsSync(path.join(projectRoot, ".twining", "pre-reverse-backup"))).toBe(false);
  });

  it("verification failure exits 1 and prints the mismatch summary", async () => {
    // Forward-migrate, then plant a divergent row directly in sqlite with a
    // mismatched inner id (same trick as reverse.test.ts) so --check fails.
    await seedOnePost();
    await runMigrateCli(["--project", projectRoot]);
    const { openDatabase } = await import("../../src/storage/sqlite/db.js");
    const db = openDatabase(path.join(projectRoot, ".twining"));
    // Tamper with the migrated row's content in the db so files ⊄ sqlite.
    const row = db.prepare("SELECT id, data FROM blackboard").all()[0]! as { id: string; data: string };
    const drifted = JSON.parse(row.data);
    drifted.summary = "drifted in db";
    db.prepare("UPDATE blackboard SET data = ? WHERE id = ?").run(JSON.stringify(drifted), row.id);
    db.close();

    const code = await runMigrateCli(["--project", projectRoot, "--check"]);
    expect(code).toBe(1);
    const out = logs.join("\n");
    expect(out).toMatch(/VERIFICATION FAILED/);
    expect(out).toMatch(/mismatched: posts\//);
  });

  it("reports per-list overflow when a single list exceeds the 20-line cap", async () => {
    // 25 mismatched posts, 0 missing: the old combined formula
    // (missing + mismatched - 40) would compute -15 and silently hide the
    // 5 truncated entries; per-list overflow must print "…and 5 more".
    const stores = createStores(path.join(projectRoot, ".twining"), { ...DEFAULT_CONFIG });
    for (let i = 0; i < 25; i++) {
      await stores.blackboardStore.append({
        entry_type: "finding", summary: `cli seed ${i}`, detail: "", tags: [], scope: "src/", agent_id: "m",
      });
    }
    await runMigrateCli(["--project", projectRoot]);

    const { openDatabase } = await import("../../src/storage/sqlite/db.js");
    const db = openDatabase(path.join(projectRoot, ".twining"));
    db.exec("UPDATE blackboard SET data = json_set(data, '$.summary', 'drifted-' || id)");
    db.close();

    logs = [];
    const code = await runMigrateCli(["--project", projectRoot, "--check"]);
    expect(code).toBe(1);
    const out = logs.join("\n");
    expect(out).toMatch(/VERIFICATION FAILED/);
    expect(out.match(/mismatched: posts\//g)).toHaveLength(20);
    expect(out).toMatch(/…and 5 more/);
  });
});

describe.skipIf(HAS_SQLITE)("runMigrateCli without node:sqlite (Node 18/20 CI legs)", () => {
  it("fails with a clear message and exit 2 instead of a silent fallback", async () => {
    logs = []; errors = [];
    const code = await runMigrateCli(["--project", projectRoot]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/node:sqlite is unavailable/);
  });
});
