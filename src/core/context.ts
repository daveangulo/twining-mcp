/**
 * Transport-agnostic Twining context (2.17.0).
 *
 * Everything createServer used to build inline — config, stores, embedder,
 * engines, sync manager, pending processor — minus the three things that are
 * MCP-server-specific: the McpServer itself, the dashboard, and telemetry.
 * `createServer` composes this and adds tool registration; `src/cli/twining.ts`
 * composes this and adds an argv front end. One stack, two front ends.
 */
import { ensureInitialized } from "../storage/init.js";
import { formatVersionRefusal, loadConfig } from "../config.js";
import { enterReadOnlyMode } from "../storage/file-store.js";
import { createStores } from "../storage/backend-factory.js";
import type { RecordSyncManager } from "../storage/sync/sync-manager.js";
import type { SqliteDatabase } from "../storage/sqlite/db.js";
import { BlackboardEngine } from "../engine/blackboard.js";
import { DecisionEngine } from "../engine/decisions.js";
import { GraphEngine } from "../engine/graph.js";
import { Archiver } from "../engine/archiver.js";
import { ContextAssembler } from "../engine/context-assembler.js";
import { PlanningBridge } from "../engine/planning-bridge.js";
import { VerifyEngine } from "../engine/verify.js";
import { PendingProcessor } from "../engine/pending-processor.js";
import { Embedder } from "../embeddings/embedder.js";
import { SearchEngine } from "../embeddings/search.js";
import { Exporter } from "../engine/exporter.js";
import { CoordinationEngine } from "../engine/coordination.js";
import { HousekeepingEngine } from "../engine/housekeeping.js";
import { GraphAutoPopulator } from "../engine/graph-auto-populator.js";
import { MetricsStore } from "../analytics/metrics-store.js";
import type { DashboardDeps } from "../dashboard/api-routes.js";

import type {
  IAgentStore,
  IIndexManager,
  IBlackboardStore,
  IDecisionStore,
  IGraphStore,
  IHandoffStore,
} from "../storage/interfaces.js";
import type { TwiningConfig } from "../utils/types.js";
import type { ServerIdentity } from "./commands/lifecycle.js";
import { PKG_VERSION } from "../version.js";

export interface TwiningContextOptions {
  /**
   * Run fire-and-forget background work: the startup pending-queue drain, its
   * 60s repeat timer, and the sqlite startup embedding reconcile. True for the
   * long-lived stdio server; false for the CLI, where the process exits in
   * milliseconds and a half-finished background write is a worse failure mode
   * than a queue drained by the next server start (the drain is
   * at-least-once and idempotent, so nothing is lost by deferring it).
   */
  background?: boolean;
  /**
   * Never reach the network for an embedding model. When the local model is
   * absent the embedder goes straight to keyword fallback instead of letting
   * @huggingface/transformers attempt a download. Required in sandboxes
   * (Codex runs shell commands with no network).
   */
  offline?: boolean;
}

export interface TwiningContext {
  projectRoot: string;
  twiningDir: string;
  config: TwiningConfig;
  serverVersion: string;
  /** config tools.full_surface — the MCP tool surface AND the provisional gate. */
  fullSurface: boolean;
  /** config tools.mode — "full" registers lifecycle + graph tools. */
  toolMode: string;
  identity: ServerIdentity;

  // Stores
  blackboardStore: IBlackboardStore;
  decisionStore: IDecisionStore;
  graphStore: IGraphStore;
  agentStore: IAgentStore;
  handoffStore: IHandoffStore;
  indexManager: IIndexManager | null;
  recordSync: RecordSyncManager | null;
  db: SqliteDatabase | null;

  // Embeddings
  embedder: Embedder;
  searchEngine: SearchEngine;

  // Engines
  blackboardEngine: BlackboardEngine;
  decisionEngine: DecisionEngine;
  graphEngine: GraphEngine;
  archiver: Archiver;
  contextAssembler: ContextAssembler;
  planningBridge: PlanningBridge;
  coordinationEngine: CoordinationEngine;
  verifyEngine: VerifyEngine;
  housekeepingEngine: HousekeepingEngine;
  exporter: Exporter;
  pendingProcessor: PendingProcessor;
  graphPopulator: GraphAutoPopulator | null;

  /** Shared store/engine instances for the dashboard — one stack, not two. */
  dashboardDeps: DashboardDeps;
  /** Probe for git-driven record staleness. The MCP front end patches this
   *  onto registerTool (attachSyncProbe); the CLI calls it before dispatch.
   *  No-op on the files backend. */
  maybeResync: () => void;
  /** Close the sqlite handle (sqlite checkpoints its WAL on close — S4-7).
   *  No-op on the files backend. */
  closeDb: () => void;
  /** Stop the periodic drain timer (no-op when background work is off). */
  stopBackgroundWork: () => void;
}

/**
 * Build the full Twining stack for a project root. Auto-creates .twining/ on
 * first use (see ensureInitialized).
 */
export function createTwiningContext(
  projectRoot: string,
  options: TwiningContextOptions = {},
): TwiningContext {
  const background = options.background ?? true;

  // Ensure .twining/ directory exists
  const twiningDir = ensureInitialized(projectRoot);

  // Load config
  const config = loadConfig(twiningDir);

  // Refuse writes when the on-disk format is newer than this release —
  // a migrated project must not be written to by a stale client.
  const versionRefusal = formatVersionRefusal(config);
  if (versionRefusal) {
    console.error(`[twining] ${versionRefusal}`);
    enterReadOnlyMode(versionRefusal);
  }

  // Create stores for the configured backend ("files" default, "sqlite" opt-in)
  const {
    backend,
    reason: backendReason,
    legacy_unread: legacyUnread,
    records_unread: recordsUnread,
    blackboardStore,
    decisionStore,
    graphStore,
    agentStore,
    handoffStore,
    indexManager,
    recordSync,
    db,
  } = createStores(twiningDir, config);

  // Create embedding layer (lazy-loaded — no ONNX init cost at startup)
  const embedder = Embedder.getInstance(twiningDir, {
    offline: options.offline ?? false,
  });
  const searchEngine = new SearchEngine(embedder, indexManager);

  // W2.3 phase 2 (sqlite only): embed what the startup ingest inserted, and
  // keep the database converged when git moves HEAD mid-session.
  if (recordSync) {
    recordSync.setEmbedder(embedder);
    if (background) recordSync.scheduleReconcile();
  }

  // Create engines (with embedding support)
  const blackboardEngine = new BlackboardEngine(
    blackboardStore,
    embedder,
    indexManager,
    searchEngine,
    projectRoot,
  );
  const graphEngine = new GraphEngine(graphStore);
  // Decision-side population stays unconditionally on (pre-1.21 behavior);
  // only the blackboard-side populator below is gated by config.graph.auto_populate.
  // Unifying the two behind the config flag is a deliberate behavior change
  // deferred to a release of its own.
  const decisionGraphPopulator = new GraphAutoPopulator(graphEngine);
  const decisionEngine = new DecisionEngine(
    decisionStore,
    blackboardEngine,
    embedder,
    indexManager,
    projectRoot,
    searchEngine,
    decisionGraphPopulator,
  );
  const archiver = new Archiver(
    twiningDir,
    blackboardStore,
    blackboardEngine,
    indexManager,
  );

  // Create graph auto-populator for relation extraction from tool calls (opt-in)
  const autoPopulate = config.graph?.auto_populate ?? false;
  const graphPopulator = autoPopulate ? new GraphAutoPopulator(graphEngine) : null;

  // Wire graph auto-populator into blackboard engine for post extraction
  if (graphPopulator) {
    blackboardEngine.setGraphPopulator(graphPopulator);
  }

  // Wire auto-archive threshold into blackboard engine (spec §6.1.3)
  blackboardEngine.setArchiver(archiver, config);

  // Wire registry auto-touch: every post/decide/record marks its author as
  // a participant, so the registry reflects who actually worked here (#32)
  blackboardEngine.setAgentStore(agentStore);

  const planningBridge = new PlanningBridge(projectRoot);

  const contextAssembler = new ContextAssembler(
    blackboardStore,
    decisionStore,
    searchEngine,
    config,
    graphEngine,
    planningBridge,
    handoffStore,   // for recent handoffs in assembly
    agentStore,     // for agent suggestions in assembly
  );
  // Self-authorship marking in the warning lane (field D12): the assembler
  // marks entries this session posted, by exact id membership.
  contextAssembler.setSessionPostIds(blackboardEngine.sessionPostIds);

  // Wire assembly-before-decision tracking
  decisionEngine.setAssemblyChecker((agentId) =>
    contextAssembler.hasRecentAssembly(agentId),
  );

  // Create coordination engine
  const coordinationEngine = new CoordinationEngine(
    agentStore,
    handoffStore,
    blackboardEngine,
    decisionStore,
    blackboardStore,
    config,
  );

  // Create verify engine
  const verifyEngine = new VerifyEngine(
    decisionStore,
    blackboardStore,
    blackboardEngine,
    graphEngine,
    projectRoot,
  );
  verifyEngine.setAssemblyChecker((agentId) =>
    contextAssembler.hasRecentAssembly(agentId),
  );

  // Create housekeeping engine
  const housekeepingEngine = new HousekeepingEngine(
    twiningDir,
    blackboardStore,
    decisionStore,
    archiver,
    graphEngine,
    projectRoot,
    config.housekeeping?.staleness_threshold,
    config.archive.retain_recent,
    db ?? null,
  );

  // Create exporter
  const exporter = new Exporter(blackboardStore, decisionStore, graphStore);

  // Process pending posts and actions (fire-and-forget, non-fatal)
  const pendingProcessor = new PendingProcessor(
    twiningDir,
    blackboardEngine,
    archiver,
    config.archive.retain_recent,
  );
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  if (background) {
    pendingProcessor.processOnStartup().catch((err) => {
      console.error("[twining] Pending processor failed (non-fatal):", err);
    });

    // Periodic drain: startup alone left posts stuck for the lifetime of a
    // long-running server (field repos saw multi-day-old queued posts). The
    // rename-based swap in PendingProcessor makes repeated draining safe —
    // at-least-once semantics: a rare race with another server process
    // draining concurrently can duplicate a post, it can never lose one.
    drainTimer = setInterval(() => {
      pendingProcessor.processPending().catch((err) => {
        console.error("[twining] Periodic pending drain failed (non-fatal):", err);
      });
    }, 60_000);
    drainTimer.unref();
  }

  const dashboardDeps: DashboardDeps = {
    blackboardStore,
    decisionStore,
    graphStore,
    agentStore,
    handoffStore,
    metricsStore: new MetricsStore(twiningDir),
    blackboardEngine,
    decisionEngine,
    graphEngine,
  };

  const closeDb = (): void => {
    try {
      db?.close();
    } catch {
      // Already closed or mid-write teardown — nothing useful to do.
    }
  };

  return {
    projectRoot,
    twiningDir,
    config,
    serverVersion: PKG_VERSION,
    fullSurface: config.tools?.full_surface ?? false,
    toolMode: config.tools?.mode ?? "full",
    identity: {
      serverVersion: PKG_VERSION,
      backend,
      backendReason,
      legacyUnread,
      recordsUnread,
    },

    blackboardStore,
    decisionStore,
    graphStore,
    agentStore,
    handoffStore,
    indexManager: indexManager ?? null,
    recordSync: recordSync ?? null,
    db: db ?? null,

    embedder,
    searchEngine,

    blackboardEngine,
    decisionEngine,
    graphEngine,
    archiver,
    contextAssembler,
    planningBridge,
    coordinationEngine,
    verifyEngine,
    housekeepingEngine,
    exporter,
    pendingProcessor,
    graphPopulator,

    dashboardDeps,
    maybeResync: () => {
      try {
        recordSync?.maybeResync();
      } catch {
        // The probe must never break a command.
      }
    },
    closeDb,
    stopBackgroundWork: () => {
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = null;
    },
  };
}
