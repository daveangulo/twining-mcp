// src/migrate/forward.ts
/**
 * Forward migration (FOUNDATION-PLAN W3): file backend → sqlite backend.
 *
 * NOT a special importer — this is "write the W2.3 export tree from the
 * file stores, then ordinary ingest" (plan step 5), so every parsing,
 * upsert, and deletion-safety rule is the shipped, soak-tested one:
 *
 *   file stores ──RecordExporter──▶ .twining/records/ ──ingestRecords──▶ twining.db
 *
 * Legacy files are never modified or deleted (they are their own backup);
 * the only file edited is config.yml (backed up by setStorageBackend).
 * Idempotent: exports are deterministic bytes, ingest is upsert-by-ULID,
 * and a re-run sweeps up straggler writes made to the legacy files by
 * stale clients. Verification is subset-containment (files ⊆ sqlite) so
 * re-runs verify clean after sqlite-era writes exist. Embeddings are not
 * migrated: the 1.22 startup reconcile rebuilds them by content hash.
 * config.version stays 1 — the format-v2 flip ships with v2.0, not here.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { atomicWriteFileSync } from "../storage/file-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import {
  SqliteBlackboardStore,
  SqliteDecisionStore,
  SqliteGraphStore,
  SqliteHandoffStore,
} from "../storage/sqlite/sqlite-stores.js";
import { openDatabase, sqliteAvailable } from "../storage/sqlite/db.js";
import { RecordExporter } from "../storage/sync/record-export.js";
import { ingestRecords } from "../storage/sync/record-ingest.js";
import { setStorageBackend } from "./config-edit.js";
import { verifyContains, type ReadModelStores, type VerifyResult } from "./verify.js";

export interface ForwardOptions {
  projectRoot: string;
  dryRun: boolean;
  /** Verify only — no export, no ingest, no finalize. */
  checkOnly?: boolean;
}

export interface MigrateReport extends VerifyResult {
  dryRun: boolean;
  verified: boolean;
  finalized: boolean;
  configBackup: string | null;
  configHadComments: boolean;
  notes: string[];
}

/**
 * Legacy projects predate the sqlite backend's gitignore lines, so without
 * this the migration's own artifacts (twining.db + WAL/SHM) become
 * git-visible. Idempotently appends the missing lines to
 * .twining/.gitignore; returns true when anything was added.
 */
function ensureDbGitignored(twiningDir: string): boolean {
  const gitignorePath = path.join(twiningDir, ".gitignore");
  const wanted = ["twining.db", "twining.db-wal", "twining.db-shm"];

  const exists = fs.existsSync(gitignorePath);
  const raw = exists ? fs.readFileSync(gitignorePath, "utf-8") : "";
  const present = new Set(raw.split("\n").map((l) => l.trim()));
  const toAdd = wanted.filter((line) => !present.has(line));
  if (toAdd.length === 0) return false;

  const base = raw.length > 0 && !raw.endsWith("\n") ? raw + "\n" : raw;
  const next = base + toAdd.join("\n") + "\n";
  if (exists) atomicWriteFileSync(gitignorePath, next);
  else fs.writeFileSync(gitignorePath, next);
  return true;
}

export async function migrateForward(opts: ForwardOptions): Promise<MigrateReport> {
  const twiningDir = path.join(opts.projectRoot, ".twining");
  if (!fs.existsSync(twiningDir)) {
    throw new Error(`no .twining/ directory at ${twiningDir} — nothing to migrate`);
  }
  if (!sqliteAvailable()) {
    throw new Error(
      "node:sqlite is unavailable (requires Node >= 22.13) — the sqlite backend cannot run here, refusing to migrate",
    );
  }

  // Refuse the destructive re-run: with export_records disabled, sqlite-era
  // records have no files in records/, and ingest's deletion propagation
  // would remove their rows when the migration re-ingests the tree.
  const config = loadConfig(twiningDir);
  if (config.storage?.backend === "sqlite" && config.storage?.export_records === false) {
    throw new Error(
      "this project runs the sqlite backend with export_records disabled — re-running migrate would delete sqlite-era records not mirrored in records/; enable storage.export_records first",
    );
  }

  const legacy: ReadModelStores = {
    blackboardStore: new BlackboardStore(twiningDir),
    decisionStore: new DecisionStore(twiningDir),
    graphStore: new GraphStore(twiningDir),
    handoffStore: new HandoffStore(twiningDir),
  };

  const notes = [
    "agents registry, archive/, metrics, and pending queues are backend-agnostic — untouched",
    "embeddings are not migrated; the sqlite backend rebuilds them by content hash on first start",
  ];

  if (opts.dryRun) {
    // Count through the same reads a real run would use; write nothing.
    const counts = {
      posts: (await legacy.blackboardStore.read()).entries.length,
      decisions: (await legacy.decisionStore.getIndex()).length,
      entities: (await legacy.graphStore.getEntities()).length,
      relations: (await legacy.graphStore.getRelations()).length,
      handoffs: (await legacy.handoffStore.list({})).length,
    };
    return {
      ok: true, counts, missing: [], mismatched: [],
      dryRun: true, verified: false, finalized: false,
      configBackup: null, configHadComments: false, notes,
    };
  }

  if (opts.checkOnly && !fs.existsSync(path.join(twiningDir, "twining.db"))) {
    // Nothing to check against — and opening the db here would create an
    // empty one as a side effect of a supposedly read-only check.
    const counts = {
      posts: (await legacy.blackboardStore.read()).entries.length,
      decisions: (await legacy.decisionStore.getIndex()).length,
      entities: (await legacy.graphStore.getEntities()).length,
      relations: (await legacy.graphStore.getRelations()).length,
      handoffs: (await legacy.handoffStore.list({})).length,
    };
    return {
      ok: false, counts, missing: [], mismatched: [],
      dryRun: false, verified: false, finalized: false,
      configBackup: null, configHadComments: false,
      notes: [...notes, "not migrated — twining.db absent"],
    };
  }

  if (!opts.checkOnly) {
    // 1. Export: file stores → per-ULID records tree (deterministic bytes).
    const exporter = new RecordExporter(twiningDir);
    for (const entry of (await legacy.blackboardStore.read()).entries) {
      exporter.post(entry);
    }
    for (const ix of await legacy.decisionStore.getIndex()) {
      const decision = await legacy.decisionStore.get(ix.id);
      if (decision) exporter.decision(decision);
    }
    for (const entity of await legacy.graphStore.getEntities()) {
      exporter.entity(entity);
    }
    for (const relation of await legacy.graphStore.getRelations()) {
      exporter.relation(relation);
    }
    for (const ix of await legacy.handoffStore.list({})) {
      const record = await legacy.handoffStore.get(ix.id);
      if (record) exporter.handoff(record);
    }
  }

  // 2. Converge the database to the tree (creates twining.db if absent —
  //    the checkOnly-without-db case already returned above).
  const db = openDatabase(twiningDir);
  try {
    if (!opts.checkOnly) ingestRecords(db, twiningDir);

    // 3. Verify: everything the file stores can read is in sqlite, identical.
    const sqlite: ReadModelStores = {
      blackboardStore: new SqliteBlackboardStore(db),
      decisionStore: new SqliteDecisionStore(db),
      graphStore: new SqliteGraphStore(db),
      handoffStore: new SqliteHandoffStore(db),
    };
    const verdict = await verifyContains(legacy, sqlite);

    if (!verdict.ok || opts.checkOnly) {
      return {
        ...verdict, dryRun: false, verified: verdict.ok, finalized: false,
        configBackup: null, configHadComments: false, notes,
      };
    }

    // 4. Finalize: flip the backend. version stays 1 — the v2 flip is gated.
    const edit = setStorageBackend(twiningDir, "sqlite");
    if (ensureDbGitignored(twiningDir)) {
      notes.push("added twining.db* to .twining/.gitignore (predates the sqlite backend)");
    }
    return {
      ...verdict, dryRun: false, verified: true, finalized: true,
      configBackup: edit.backedUpTo, configHadComments: edit.hadComments, notes,
    };
  } finally {
    db.close();
  }
}
