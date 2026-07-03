/**
 * Storage backend selection (FOUNDATION-PLAN W2.2).
 *
 * Builds the store set for the configured backend:
 * - "files" (default): the JSON-file layout under .twining/
 * - "sqlite": single database at .twining/twining.db via node:sqlite —
 *   opt-in until v2.0; requires Node >= 22.13. When requested but
 *   unavailable (older Node, open failure), falls back to "files" with a
 *   warning rather than refusing to start: a coordination server must not
 *   be the reason a session can't boot.
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
  const requested = config.storage?.backend ?? "files";

  if (requested === "sqlite") {
    try {
      if (!sqliteAvailable()) {
        throw new Error("node:sqlite is unavailable (requires Node >= 22.13)");
      }
      const db = openDatabase(twiningDir);

      // W2.3: converge the database to the committed export tree first —
      // this is where another user's / branch's records arrive after a
      // git pull. Non-fatal: a broken tree must not stop the server.
      try {
        const stats = ingestRecords(db, twiningDir);
        if (stats.inserted || stats.updated || stats.deleted) {
          console.error(
            `[twining] Ingested records: +${stats.inserted} ~${stats.updated} -${stats.deleted}` +
              (stats.skipped ? ` (${stats.skipped} unparseable skipped)` : ""),
          );
        }
      } catch (err) {
        console.error(
          "[twining] Record ingest failed (non-fatal):",
          err instanceof Error ? err.message : String(err),
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
        // snapshot means "HEAD as of the last ingest".
        recordSync: new RecordSyncManager(
          db,
          twiningDir,
          path.dirname(twiningDir),
        ),
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
