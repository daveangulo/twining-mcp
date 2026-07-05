// test/migrate/forward.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { createStores, type StoreSet } from "../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { migrateForward } from "../../src/migrate/forward.js";
import type { TwiningConfig } from "../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

let projectRoot: string;
let twiningDir: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-fwd-"));
  twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  // file DecisionStore precondition (matches verify.test.ts convention)
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "decisions", "index.json"), "[]");
  fs.writeFileSync(
    path.join(twiningDir, "config.yml"),
    yaml.dump({ version: 1, project_name: "fwd-test" }),
  );
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

const filesConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { ...DEFAULT_CONFIG.storage, backend: "files" },
});
const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

async function seedFiles(): Promise<StoreSet> {
  const stores = createStores(twiningDir, filesConfig());
  await stores.blackboardStore.append({
    entry_type: "finding", summary: "legacy finding", detail: "d",
    tags: ["x"], scope: "src/", agent_id: "main",
  });
  const dec = await stores.decisionStore.create({
    agent_id: "main", domain: "architecture", scope: "src/", summary: "legacy decision",
    context: "c", rationale: "r", alternatives: [], confidence: "high",
    affected_files: [], affected_symbols: [], reversible: true,
  } as never);
  await stores.decisionStore.updateStatus(dec.id, "provisional");
  const e = await stores.graphStore.addEntity({ name: "auth", type: "module" });
  await stores.graphStore.addEntity({ name: "db", type: "module" });
  await stores.graphStore.addRelation({ source: e.id, target: "db", type: "depends_on" });
  await stores.handoffStore.create({
    source_agent: "a", target_agent: "b", scope: "src/", summary: "h", results: [],
    context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
  });
  return stores;
}

describe.skipIf(!HAS_SQLITE)("migrateForward", () => {
  it("migrates a seeded file backend: tree written, db converged, config flipped", async () => {
    await seedFiles();
    const report = await migrateForward({ projectRoot, dryRun: false });

    expect(report.verified).toBe(true);
    expect(report.finalized).toBe(true);
    expect(report.counts).toEqual({
      posts: 1, decisions: 1, entities: 2, relations: 1, handoffs: 1,
    });

    const cfg = yaml.load(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")) as {
      version: number; storage: { backend: string };
    };
    expect(cfg.storage.backend).toBe("sqlite");
    expect(cfg.version).toBe(1); // gated v2 flip untouched

    const sqlite = createStores(twiningDir, sqliteConfig());
    expect(sqlite.backend).toBe("sqlite");
    const { entries } = await sqlite.blackboardStore.read();
    expect(entries.map((e) => e.summary)).toEqual(["legacy finding"]);
    const index = await sqlite.decisionStore.getIndex();
    expect(index[0]!.status).toBe("provisional"); // status survived
    // Legacy files are untouched (they are their own backup):
    expect(fs.readFileSync(path.join(twiningDir, "blackboard.jsonl"), "utf-8"))
      .toContain("legacy finding");
    // Legacy projects predate the sqlite gitignore lines — migration adds them:
    expect(fs.readFileSync(path.join(twiningDir, ".gitignore"), "utf-8"))
      .toContain("twining.db");
    expect(report.notes).toContain(
      "added twining.db* to .twining/.gitignore (predates the sqlite backend)",
    );
  });

  it("is idempotent: second run verifies clean and leaves config semantically identical", async () => {
    await seedFiles();
    await migrateForward({ projectRoot, dryRun: false });
    const before = yaml.load(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8"));

    const second = await migrateForward({ projectRoot, dryRun: false });
    expect(second.verified).toBe(true);
    expect(yaml.load(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8"))).toEqual(before);
  });

  it("straggler re-run: a late write to legacy files is picked up, sqlite-era records survive", async () => {
    const legacy = await seedFiles();
    await migrateForward({ projectRoot, dryRun: false });

    const sqlite = createStores(twiningDir, sqliteConfig());
    await sqlite.blackboardStore.append({
      entry_type: "status", summary: "sqlite era", detail: "", tags: [], scope: "project", agent_id: "m",
    });
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "straggler", detail: "", tags: [], scope: "src/", agent_id: "old",
    });

    const rerun = await migrateForward({ projectRoot, dryRun: false });
    expect(rerun.verified).toBe(true); // subset semantics: sqlite ⊇ legacy

    const after = createStores(twiningDir, sqliteConfig());
    const { entries } = await after.blackboardStore.read();
    expect(entries.map((e) => e.summary).sort()).toEqual(["legacy finding", "sqlite era", "straggler"]);
  });

  it("dry-run reports counts and writes nothing", async () => {
    await seedFiles();
    const before = fs.readdirSync(twiningDir).sort();
    const cfgBefore = fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8");

    const report = await migrateForward({ projectRoot, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.counts.posts).toBe(1);
    expect(report.finalized).toBe(false);
    expect(fs.readdirSync(twiningDir).sort()).toEqual(before); // no records/, no twining.db
    expect(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")).toBe(cfgBefore);
  });

  it("checkOnly verifies without writing, and fails cleanly on divergence", async () => {
    await seedFiles();
    await migrateForward({ projectRoot, dryRun: false });
    const ok = await migrateForward({ projectRoot, dryRun: false, checkOnly: true });
    expect(ok.verified).toBe(true);
    expect(ok.finalized).toBe(false);

    for (const f of ["twining.db", "twining.db-wal", "twining.db-shm"]) {
      fs.rmSync(path.join(twiningDir, f), { force: true });
    }
    const bad = await migrateForward({ projectRoot, dryRun: false, checkOnly: true });
    expect(bad.verified).toBe(false);
    expect(bad.missing).toEqual([]);
    expect(bad.notes).toContain("not migrated — twining.db absent");
    expect(bad.finalized).toBe(false);
    // check must not have created an empty db as a side effect
    expect(fs.existsSync(path.join(twiningDir, "twining.db"))).toBe(false);
  });

  it("re-heals a partial export: missing records subtree and db are rebuilt on re-run", async () => {
    await seedFiles();
    await migrateForward({ projectRoot, dryRun: false });

    // Simulate an interrupted first run: part of the tree and the db are gone.
    fs.rmSync(path.join(twiningDir, "records", "decisions"), { recursive: true, force: true });
    for (const f of ["twining.db", "twining.db-wal", "twining.db-shm"]) {
      fs.rmSync(path.join(twiningDir, f), { force: true });
    }

    const rerun = await migrateForward({ projectRoot, dryRun: false });
    expect(rerun.verified).toBe(true);
    expect(rerun.finalized).toBe(true);

    const sqlite = createStores(twiningDir, sqliteConfig());
    const index = await sqlite.decisionStore.getIndex();
    expect(index).toHaveLength(1);
    const decision = await sqlite.decisionStore.get(index[0]!.id);
    expect(decision?.summary).toBe("legacy decision");
  });

  it("errors when .twining/ is absent", async () => {
    fs.rmSync(twiningDir, { recursive: true, force: true });
    await expect(migrateForward({ projectRoot, dryRun: false })).rejects.toThrow(/no \.twining/i);
  });

  it("salvages a decision file orphaned from the index (write-path desync)", async () => {
    await seedFiles();

    // Simulate the desync: a decision file exists on disk but was never
    // (or is no longer) recorded in decisions/index.json.
    const decisionsDir = path.join(twiningDir, "decisions");
    const [existingFile] = fs
      .readdirSync(decisionsDir)
      .filter((f) => f !== "index.json");
    const original = JSON.parse(
      fs.readFileSync(path.join(decisionsDir, existingFile!), "utf-8"),
    ) as { id: string; summary: string };
    const orphanId = "01ORPHANDECISIONULIDXXXXXXXX";
    const orphan = { ...original, id: orphanId, summary: "orphaned decision" };
    fs.writeFileSync(
      path.join(decisionsDir, `${orphanId}.json`),
      JSON.stringify(orphan, null, 2),
    );
    // Deliberately NOT added to index.json — that's the desync.

    const report = await migrateForward({ projectRoot, dryRun: false });
    expect(report.verified).toBe(true);
    expect(report.finalized).toBe(true);
    expect(report.orphans_salvaged).toBe(1);
    expect(report.notes.join(" ")).toContain(
      "salvaged 1 decision(s) present on disk but missing from decisions/index.json",
    );

    const sqlite = createStores(twiningDir, sqliteConfig());
    const salvaged = await sqlite.decisionStore.get(orphanId);
    expect(salvaged).not.toBeNull();
    expect(salvaged?.summary).toBe("orphaned decision");

    // The original (non-orphan) decision from seedFiles is still present too.
    const index = await sqlite.decisionStore.getIndex();
    expect(index.map((d) => d.id).sort()).toEqual(
      [original.id, orphanId].sort(),
    );
  });

  it("skips an unparseable decision file without deleting it and without counting it as salvaged", async () => {
    await seedFiles();
    const decisionsDir = path.join(twiningDir, "decisions");
    fs.writeFileSync(path.join(decisionsDir, "not-json-decision.json"), "{ not valid json");

    const report = await migrateForward({ projectRoot, dryRun: false });
    expect(report.verified).toBe(true);
    expect(report.orphans_salvaged).toBe(0);
    // Never deleted — legacy files are their own backup.
    expect(fs.existsSync(path.join(decisionsDir, "not-json-decision.json"))).toBe(true);
  });

  it("refuses to run against a sqlite backend with export_records disabled", async () => {
    fs.writeFileSync(
      path.join(twiningDir, "config.yml"),
      yaml.dump({
        version: 1,
        project_name: "fwd-test",
        storage: { backend: "sqlite", export_records: false },
      }),
    );
    await expect(migrateForward({ projectRoot, dryRun: false })).rejects.toThrow(/export_records/);
  });
});
