// test/migrate/verify.test.ts
/**
 * Backend-agnostic read-model containment: every record readable from the
 * source stores must exist, byte-identically (stable serialization), in the
 * target stores. Subset semantics on purpose — a straggler re-run migrates
 * late legacy writes into a sqlite store that already has newer records.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStores, type StoreSet } from "../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { verifyContains } from "../../src/migrate/verify.js";
import { RecordExporter } from "../../src/storage/sync/record-export.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import { ingestRecords } from "../../src/storage/sync/record-ingest.js";
import type { TwiningConfig } from "../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

const filesConfig = (): TwiningConfig => ({ ...DEFAULT_CONFIG });
const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-verify-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function twining(sub: string): string {
  const p = path.join(dir, sub, ".twining");
  fs.mkdirSync(p, { recursive: true });
  // DecisionStore.create() locks/reads decisions/index.json and expects it
  // to pre-exist (mirrors the file-backend layout precedent in
  // test/sqlite-backend.test.ts's cross-backend parity test) — every other
  // store lazily creates its own directory/files on first write.
  fs.mkdirSync(path.join(p, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(p, "decisions", "index.json"), "[]");
  return p;
}

async function seed(stores: StoreSet) {
  const entry = await stores.blackboardStore.append({
    entry_type: "finding", summary: "s", detail: "d", tags: [], scope: "src/", agent_id: "main",
  });
  const decision = await stores.decisionStore.create({
    agent_id: "main", domain: "architecture", scope: "src/", summary: "dec",
    context: "c", rationale: "r", alternatives: [], confidence: "high",
    affected_files: [], affected_symbols: [], reversible: true,
  } as never);
  const ent = await stores.graphStore.addEntity({ name: "auth", type: "module" });
  await stores.graphStore.addEntity({ name: "db", type: "module" });
  await stores.graphStore.addRelation({ source: ent.id, target: "db", type: "depends_on" });
  await stores.handoffStore.create({
    source_agent: "a", target_agent: "b", scope: "src/", summary: "h", results: [],
    context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
  });
  return { entry, decision };
}

/** Copy every source record into targetDir's export tree, then ingest. */
async function buildSqliteTargetFrom(source: StoreSet, targetDir: string): Promise<StoreSet> {
  const exporter = new RecordExporter(targetDir);
  for (const e of (await source.blackboardStore.read()).entries) exporter.post(e);
  for (const ix of await source.decisionStore.getIndex()) {
    exporter.decision((await source.decisionStore.get(ix.id))!);
  }
  for (const e of await source.graphStore.getEntities()) exporter.entity(e);
  for (const r of await source.graphStore.getRelations()) exporter.relation(r);
  for (const ix of await source.handoffStore.list({})) {
    exporter.handoff((await source.handoffStore.get(ix.id))!);
  }
  const db = openDatabase(targetDir);
  ingestRecords(db, targetDir);
  db.close();
  return createStores(targetDir, sqliteConfig());
}

describe.skipIf(!HAS_SQLITE)("verifyContains", () => {
  it("passes when the target holds every source record identically", async () => {
    const source = createStores(twining("a"), filesConfig());
    await seed(source);
    const target = await buildSqliteTargetFrom(source, twining("b"));

    const result = await verifyContains(source, target);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual([]);
    expect(result.counts).toEqual({
      posts: 1, decisions: 1, entities: 2, relations: 1, handoffs: 1,
    });
  });

  it("subset: target with EXTRA records still contains the source", async () => {
    const source = createStores(twining("a"), filesConfig());
    await seed(source);
    const target = await buildSqliteTargetFrom(source, twining("b"));
    await target.blackboardStore.append({
      entry_type: "status", summary: "extra sqlite-era post", detail: "", tags: [], scope: "project", agent_id: "x",
    });

    const result = await verifyContains(source, target);
    expect(result.ok).toBe(true); // subset semantics: extras in target are fine
    expect(result.counts.posts).toBe(1); // counts reflect the source only
  });

  it("reports missing records with kind-qualified ids", async () => {
    const source = createStores(twining("a"), filesConfig());
    const { entry, decision } = await seed(source);
    const target = createStores(twining("b"), sqliteConfig()); // empty

    const result = await verifyContains(source, target);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain(`posts/${entry.id}`);
    expect(result.missing).toContain(`decisions/${decision.id}`);
    expect(result.missing.length).toBe(6); // 1 post + 1 decision + 2 entities + 1 relation + 1 handoff
    expect(result.mismatched).toEqual([]);
  });

  it("reports mismatched records when the same id has drifted content", async () => {
    const source = createStores(twining("a"), filesConfig());
    const { decision } = await seed(source);
    const targetDir = twining("b");
    const target = await buildSqliteTargetFrom(source, targetDir);

    // Drift the decision's content in the target under the SAME id.
    const db = openDatabase(targetDir);
    const row = db.prepare("SELECT data FROM decisions WHERE id = ?").get(decision.id) as { data: string };
    const drifted = JSON.parse(row.data);
    drifted.summary = "drifted";
    db.prepare("UPDATE decisions SET data = ? WHERE id = ?").run(JSON.stringify(drifted), decision.id);
    db.close();

    const result = await verifyContains(source, target);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual([`decisions/${decision.id}`]);
    expect(result.missing).toEqual([]);
  });
});
