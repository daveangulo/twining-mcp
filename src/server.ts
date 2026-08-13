/**
 * MCP server creation with all tool registrations.
 * Creates stores, engines, and registers all tools.
 * Phase 3: Adds knowledge graph layer and lifecycle management.
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureInitialized } from "./storage/init.js";

// __TWINING_VERSION__ is baked in by the bundle build (relocation-safe);
// the tsc build falls back to the package.json lookup relative to dist/.
const PKG_VERSION =
  typeof __TWINING_VERSION__ !== "undefined"
    ? __TWINING_VERSION__
    : (createRequire(import.meta.url)("../package.json") as { version: string }).version;
import { formatVersionRefusal, loadConfig } from "./config.js";
import { enterReadOnlyMode } from "./storage/file-store.js";
import { createStores } from "./storage/backend-factory.js";
import { attachSyncProbe } from "./storage/sync/sync-manager.js";
import { BlackboardEngine } from "./engine/blackboard.js";
import { DecisionEngine } from "./engine/decisions.js";
import { GraphEngine } from "./engine/graph.js";
import { Archiver } from "./engine/archiver.js";
import { ContextAssembler } from "./engine/context-assembler.js";
import { PlanningBridge } from "./engine/planning-bridge.js";
import { VerifyEngine } from "./engine/verify.js";
import { PendingProcessor } from "./engine/pending-processor.js";
import { Embedder } from "./embeddings/embedder.js";
import { SearchEngine } from "./embeddings/search.js";
import { registerBlackboardTools } from "./tools/blackboard-tools.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerContextTools } from "./tools/context-tools.js";
import { registerRecordTools } from "./tools/record-tools.js";
import { registerLifecycleTools } from "./tools/lifecycle-tools.js";
import { registerGraphTools } from "./tools/graph-tools.js";
import { registerVerifyTools } from "./tools/verify-tools.js";
import { registerTriageTools } from "./tools/triage-tools.js";
import { Exporter } from "./engine/exporter.js";
import { registerExportTools } from "./tools/export-tools.js";
import { CoordinationEngine } from "./engine/coordination.js";
import { registerCoordinationTools } from "./tools/coordination-tools.js";
import { HousekeepingEngine } from "./engine/housekeeping.js";
import { registerHousekeepingTools } from "./tools/housekeeping-tools.js";
import { MetricsCollector } from "./analytics/metrics-collector.js";
import { createInstrumentedServer } from "./analytics/instrumented-server.js";
import { TWINING_INSTRUCTIONS } from "./instructions.js";
import { GraphAutoPopulator } from "./engine/graph-auto-populator.js";
import { MetricsStore } from "./analytics/metrics-store.js";
import type { DashboardDeps } from "./dashboard/api-routes.js";

/**
 * Create and configure the Twining MCP server.
 * Auto-creates .twining/ directory on first use.
 */
export interface ServerContext {
  server: McpServer;
  metricsCollector: MetricsCollector;
  twiningDir: string;
  config: import("./utils/types.js").TwiningConfig;
  /** Shared store/engine instances for the dashboard — one stack, not two. */
  dashboardDeps: DashboardDeps;
}

export function createServer(projectRoot: string): ServerContext {
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
    blackboardStore,
    decisionStore,
    graphStore,
    agentStore,
    handoffStore,
    indexManager,
    recordSync,
  } = createStores(twiningDir, config);
  if (backend !== (config.storage?.backend ?? "files")) {
    // createStores already logged the fallback reason
  }

  // Create embedding layer (lazy-loaded — no ONNX init cost at startup)
  const embedder = Embedder.getInstance(twiningDir);
  const searchEngine = new SearchEngine(embedder, indexManager);

  // W2.3 phase 2 (sqlite only): embed what the startup ingest inserted, and
  // keep the database converged when git moves HEAD mid-session.
  if (recordSync) {
    recordSync.setEmbedder(embedder);
    recordSync.scheduleReconcile();
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
  pendingProcessor.processOnStartup().catch((err) => {
    console.error("[twining] Pending processor failed (non-fatal):", err);
  });

  // Periodic drain: startup alone left posts stuck for the lifetime of a
  // long-running server (field repos saw multi-day-old queued posts). The
  // rename-based swap in PendingProcessor makes repeated draining safe —
  // at-least-once semantics: a rare race with another server process
  // draining concurrently can duplicate a post, it can never lose one.
  const drainTimer = setInterval(() => {
    pendingProcessor.processPending().catch((err) => {
      console.error("[twining] Periodic pending drain failed (non-fatal):", err);
    });
  }, 60_000);
  drainTimer.unref();

  // Create MCP server with workflow instructions for non-plugin clients
  const server = new McpServer(
    {
      name: "twining-mcp",
      version: PKG_VERSION,
    },
    {
      instructions: config.instructions?.auto_inject !== false
        ? TWINING_INSTRUCTIONS
        : undefined,
    },
  );

  // Instrument tool calls with metrics collection
  const metricsCollector = new MetricsCollector(twiningDir);
  if (config.analytics?.metrics?.enabled !== false) {
    createInstrumentedServer(server, metricsCollector);
  }

  // Probe for git-driven record staleness before every tool call — how a
  // branch switch or pull becomes visible without a server restart.
  if (recordSync) {
    attachSyncProbe(server, recordSync);
  }

  // Register tools — full_surface=false (default) hides rarely-used tools to reduce noise.
  // Claude Code defers tool loading via ToolSearch, so hidden tools don't appear in search.
  const toolMode = config.tools?.mode ?? "full";
  const fullSurface = config.tools?.full_surface ?? false;

  // Core tools (always registered in both full and lite modes)
  registerRecordTools(server, blackboardEngine, decisionEngine, projectRoot, twiningDir, {
    fullSurface,
  });
  registerHousekeepingTools(server, housekeepingEngine, blackboardEngine, decisionStore, twiningDir);
  registerBlackboardTools(server, blackboardEngine, twiningDir, {
    fullSurface,
    decisionEngine,
    decisionStore,
  });
  registerDecisionTools(server, decisionEngine, twiningDir, { fullSurface });
  registerContextTools(server, contextAssembler, { fullSurface });
  if (fullSurface) {
    registerVerifyTools(server, verifyEngine);
  }
  registerCoordinationTools(server, agentStore, coordinationEngine, config, graphPopulator, { fullSurface });

  // Export tools only in full surface mode
  if (fullSurface) {
    registerExportTools(server, exporter);
  }

  // Triage tool only in full surface mode in v1 (TRIAGE-SPEC §6)
  if (fullSurface) {
    registerTriageTools(server, { decisionStore, blackboardStore });
  }

  // Extended tools (full mode only)
  if (toolMode === "full") {
    registerLifecycleTools(
      server,
      twiningDir,
      blackboardStore,
      decisionStore,
      graphStore,
      archiver,
      config,
      agentStore,
    );
    registerGraphTools(server, graphEngine);
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

  return { server, metricsCollector, twiningDir, config, dashboardDeps };
}
