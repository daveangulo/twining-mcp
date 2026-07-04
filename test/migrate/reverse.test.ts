// test/migrate/reverse.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { createStores } from "../../src/storage/backend-factory.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { migrateForward } from "../../src/migrate/forward.js";
import { migrateReverse } from "../../src/migrate/reverse.js";
import type { TwiningConfig } from "../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

let projectRoot: string;
let twiningDir: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-rev-"));
  twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "decisions", "index.json"), "[]");
  fs.writeFileSync(
    path.join(twiningDir, "config.yml"),
    yaml.dump({ version: 1, project_name: "rev-test" }),
  );
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

const filesConfig = (): TwiningConfig => ({ ...DEFAULT_CONFIG });
const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

describe.skipIf(!HAS_SQLITE)("migrateReverse", () => {
  it("round-trips: forward, post more via sqlite, reverse — file backend sees everything", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "legacy", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });

    const sqlite = createStores(twiningDir, sqliteConfig());
    await sqlite.blackboardStore.append({
      entry_type: "status", summary: "sqlite era", detail: "", tags: [], scope: "project", agent_id: "m",
    });
    const dec = await sqlite.decisionStore.create({
      agent_id: "m", domain: "architecture", scope: "src/", summary: "made on sqlite",
      context: "c", rationale: "r", alternatives: [], confidence: "high",
      affected_files: [], affected_symbols: [], reversible: true,
    } as never);
    await sqlite.decisionStore.updateStatus(dec.id, "provisional");
    const ent = await sqlite.graphStore.addEntity({ name: "auth", type: "module" });
    await sqlite.graphStore.addEntity({ name: "db", type: "module" });
    await sqlite.graphStore.addRelation({ source: ent.id, target: "db", type: "depends_on" });
    const handoff = await sqlite.handoffStore.create({
      source_agent: "a", target_agent: "b", scope: "src/", summary: "h", results: [],
      context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
    });
    await sqlite.handoffStore.acknowledge(handoff.id, "b");

    const report = await migrateReverse({ projectRoot, dryRun: false });
    expect(report.verified).toBe(true);
    expect(report.finalized).toBe(true);
    expect(report.counts).toEqual({
      posts: 2, decisions: 1, entities: 2, relations: 1, handoffs: 1,
    });

    const cfg = yaml.load(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")) as {
      version: number; storage: { backend: string };
    };
    expect(cfg.storage.backend).toBe("files");
    expect(cfg.version).toBe(1);

    // Fresh file stores see the full sqlite-era state, statuses and acks included.
    const files = createStores(twiningDir, filesConfig());
    expect(files.backend).toBe("files");
    const { entries } = await files.blackboardStore.read();
    expect(entries.map((e) => e.summary).sort()).toEqual(["legacy", "sqlite era"]);
    const index = await files.decisionStore.getIndex();
    expect(index.find((d) => d.id === dec.id)!.status).toBe("provisional");
    const handoffs = await files.handoffStore.list({});
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.acknowledged).toBe(true);
    expect((await files.graphStore.getEntities()).map((e) => e.name).sort()).toEqual(["auth", "db"]);
  });

  it("backs up the file layout it overwrites", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "precious", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });
    await migrateReverse({ projectRoot, dryRun: false });

    const backupDir = path.join(twiningDir, "pre-reverse-backup");
    expect(fs.existsSync(path.join(backupDir, "blackboard.jsonl"))).toBe(true);
    expect(
      fs.readFileSync(path.join(backupDir, "blackboard.jsonl"), "utf-8"),
    ).toContain("precious");
  });

  it("dry-run reports counts and writes nothing", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "x", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });
    const cfgBefore = fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8");

    const report = await migrateReverse({ projectRoot, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.counts.posts).toBe(1);
    expect(report.finalized).toBe(false);
    expect(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")).toBe(cfgBefore);
    expect(fs.existsSync(path.join(twiningDir, "pre-reverse-backup"))).toBe(false);
  });

  it("export_records disabled: skips ingest so unmirrored sqlite rows survive the reverse", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "mirrored", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });

    // Simulate the export-off era: config flips off, sqlite writes are NOT
    // mirrored into records/ — the db becomes the only complete state.
    fs.writeFileSync(
      path.join(twiningDir, "config.yml"),
      yaml.dump({
        version: 1,
        project_name: "rev-test",
        storage: { backend: "sqlite", export_records: false },
      }),
    );
    const exportOffConfig: TwiningConfig = {
      ...DEFAULT_CONFIG,
      storage: { backend: "sqlite", export_records: false },
    };
    const sqlite = createStores(twiningDir, exportOffConfig);
    await sqlite.blackboardStore.append({
      entry_type: "status", summary: "unmirrored", detail: "", tags: [], scope: "project", agent_id: "m",
    });

    const report = await migrateReverse({ projectRoot, dryRun: false });
    expect(report.verified).toBe(true);
    expect(report.finalized).toBe(true);
    expect(report.notes.join(" ")).toContain(
      "export_records is disabled — records/ tree ignored; exporting from the database alone",
    );

    // Ingest was skipped: the unmirrored row was not deleted before export.
    const files = createStores(twiningDir, filesConfig());
    const { entries } = await files.blackboardStore.read();
    expect(entries.map((e) => e.summary).sort()).toEqual(["mirrored", "unmirrored"]);
  });

  it("errors when there is no sqlite state to reverse from", async () => {
    await expect(migrateReverse({ projectRoot, dryRun: false })).rejects.toThrow(
      /no sqlite state/i,
    );
  });

  it("does not finalize when verification fails — config stays sqlite", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "legacy", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });

    // Two rows whose data JSONs share the same inner id but differ in
    // content: the file layout writes both lines, but verify's target map
    // keys by id (last line wins), so the first row genuinely mismatches —
    // a real ok:false, not an fs error. Remove records/ so ingest (which
    // would delete these fileless rows) no-ops via its own no-tree guard.
    fs.rmSync(path.join(twiningDir, "records"), { recursive: true, force: true });
    const db = openDatabase(twiningDir);
    const row = (summary: string): string => JSON.stringify({
      id: "R1", entry_type: "finding", summary, detail: "", tags: [],
      scope: "src/", agent_id: "m", timestamp: "2026-01-01T00:00:00.000Z",
    });
    const insert = db.prepare(
      "INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("R1", "finding", "src/", "2026-01-01T00:00:00.000Z", row("first"));
    insert.run("R2", "finding", "src/", "2026-01-01T00:00:00.000Z", row("second"));
    db.close();

    const report = await migrateReverse({ projectRoot, dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.verified).toBe(false);
    expect(report.finalized).toBe(false);
    expect(report.mismatched).toContain("posts/R1");

    const cfg = yaml.load(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")) as {
      storage: { backend: string };
    };
    expect(cfg.storage.backend).toBe("sqlite");
  });

  it("refuses to re-run once the backend is already files", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "x", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });
    await migrateReverse({ projectRoot, dryRun: false });

    await expect(migrateReverse({ projectRoot, dryRun: false })).rejects.toThrow(
      /already 'files'/,
    );
  });

  it("notes mark records/ as frozen so the CLI can warn", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "x", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });
    const report = await migrateReverse({ projectRoot, dryRun: false });
    expect(report.notes.join(" ")).toMatch(/FROZEN/);
  });
});
