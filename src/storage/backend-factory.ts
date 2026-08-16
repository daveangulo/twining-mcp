/**
 * Storage backend selection (FOUNDATION-PLAN W2.2; v2 default flip).
 *
 * Builds the store set for the configured backend:
 * - "auto" (v2 default): resolved by legacy detection — sqlite state →
 *   "sqlite", legacy content → "files" plus a migrate nudge, fresh →
 *   "sqlite" (see backend-resolve.ts). Existing projects flip only
 *   through the verify-gated migrate, never implicitly.
 * - "files": the JSON-file layout under .twining/
 * - "sqlite": single database at .twining/twining.db via node:sqlite —
 *   requires Node >= 22.13. When requested but unavailable (older Node,
 *   open failure), falls back to "files" with a warning rather than
 *   refusing to start: a coordination server must not be the reason a
 *   session can't boot.
 */
import type { TwiningConfig } from "../utils/types.js";
import type {
  IAgentStore,
  IBlackboardStore,
  IDecisionStore,
  IGraphStore,
  IHandoffStore,
  IIndexManager,
} from "./interfaces.js";
import { BlackboardStore } from "./blackboard-store.js";
import { DecisionStore } from "./decision-store.js";
import { GraphStore } from "./graph-store.js";
import { AgentStore } from "./agent-store.js";
import { HandoffStore } from "./handoff-store.js";
import { IndexManager } from "../embeddings/index-manager.js";
// Safe to import statically on any Node version: node:sqlite is only
// required inside sqliteAvailable()/openDatabase(), never at module load.
import { openDatabase, sqliteAvailable } from "./sqlite/db.js";
import { resolveAutoBackend } from "./backend-resolve.js";
import {
  SqliteAgentStore,
  SqliteBlackboardStore,
  SqliteDecisionStore,
  SqliteGraphStore,
  SqliteHandoffStore,
  SqliteIndexManager,
} from "./sqlite/sqlite-stores.js";
import { withRecordExport } from "./sync/record-export.js";
import { ingestRecords } from "./sync/record-ingest.js";
import { RecordSyncManager } from "./sync/sync-manager.js";
import fs from "node:fs";
import path from "node:path";

export interface StoreSet {
  backend: "files" | "sqlite";
  blackboardStore: IBlackboardStore;
  decisionStore: IDecisionStore;
  graphStore: IGraphStore;
  agentStore: IAgentStore;
  handoffStore: IHandoffStore;
  indexManager: IIndexManager;
  /**
   * sqlite only: live re-ingest of the export tree when git moves HEAD
   * mid-session, plus embedding reconciliation (W2.3 phase 2).
   */
  recordSync?: RecordSyncManager;
}

export function createStores(
  twiningDir: string,
  config: TwiningConfig,
): StoreSet {
  const configured = config.storage?.backend ?? "auto";
  let requested: "files" | "sqlite";
  if (configured === "auto") {
    const resolution = resolveAutoBackend(twiningDir);
    requested = resolution.backend;
    if (resolution.reason === "legacy-content") {
      console.error(
        "[twining] Legacy file-backend project detected — staying on the " +
          "file backend. Run `npx twining-mcp migrate` to move to the v2 " +
          "sqlite backend (reversible; see docs/UPGRADE-v2.md).",
      );
    }
  } else {
    requested = configured;
  }

  if (requested === "sqlite") {
    try {
      if (!sqliteAvailable()) {
        throw new Error("node:sqlite is unavailable (requires Node >= 22.13)");
      }
      const db = openDatabase(twiningDir);

      // W2.3: converge the database to the committed export tree first —
      // this is where another user's / branch's records arrive after a
      // git pull. Non-fatal: a broken tree must not stop the server.
      //
      // Only when export_records is on. With it off, writes are never mirrored
      // into .twining/records/, so the tree is a stale partial snapshot and the
      // database is the only complete state — ingesting would delete every row
      // whose file is absent (record-ingest deletion propagation), silently
      // wiping post-flip work at each server start. Both migrate paths already
      // treat export_records:false this way (forward.ts, reverse.ts).
      const exportRecords = config.storage?.export_records !== false;
      if (exportRecords) {
        try {
          const stats = ingestRecords(db, twiningDir);
          if (stats.inserted || stats.updated || stats.deleted) {
            console.error(
              `[twining] Ingested records: +${stats.inserted} ~${stats.updated} -${stats.deleted}` +
                (stats.skipped ? ` (${stats.skipped} unparseable skipped)` : "") +
                (stats.lifecycle_reverts
                  ? ` (${stats.lifecycle_reverts} lifecycle revert(s) — see preceding lines)`
                  : ""),
            );
          }
        } catch (err) {
          console.error(
            "[twining] Record ingest failed (non-fatal):",
            err instanceof Error ? err.message : String(err),
          );
        }
      } else if (fs.existsSync(path.join(twiningDir, "records"))) {
        console.error(
          "[twining] storage.export_records is false but .twining/records/ exists — " +
            "the tree is stale and is NOT being ingested. Re-enabling export_records " +
            "would overwrite database rows from it.",
        );
      }

      let set: StoreSet = {
        backend: "sqlite",
        blackboardStore: new SqliteBlackboardStore(db),
        decisionStore: new SqliteDecisionStore(db),
        graphStore: new SqliteGraphStore(db),
        agentStore: new SqliteAgentStore(db),
        handoffStore: new SqliteHandoffStore(db),
        indexManager: new SqliteIndexManager(db),
        // Constructed immediately after the startup ingest so its HEAD
        // snapshot means "HEAD as of the last ingest". Omitted entirely when
        // export_records is off: its maybeResync re-ingests on HEAD moves, and
        // ingesting against a stale tree deletes database-only rows mid-session.
        ...(exportRecords
          ? {
              recordSync: new RecordSyncManager(
                db,
                twiningDir,
                path.dirname(twiningDir),
              ),
            }
          : {}),
      };
      // Mirror every write into .twining/records/ — the committable truth
      // (twining.db itself is a gitignored local cache).
      if (config.storage?.export_records !== false) {
        set = withRecordExport(set, twiningDir);
      }
      return set;
    } catch (err) {
      console.error(
        `[twining] sqlite backend requested but unavailable (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to the file backend.`,
      );
    }
  }

  return {
    backend: "files",
    blackboardStore: new BlackboardStore(twiningDir),
    decisionStore: new DecisionStore(twiningDir),
    graphStore: new GraphStore(twiningDir),
    agentStore: new AgentStore(twiningDir),
    handoffStore: new HandoffStore(twiningDir),
    indexManager: new IndexManager(twiningDir),
  };
}
