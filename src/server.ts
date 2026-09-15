/**
 * MCP server creation with all tool registrations.
 *
 * As of 2.17.0 the store/engine stack lives in src/core/context.ts
 * (createTwiningContext) and every tool handler lives in src/core/commands/*.
 * What is left here is MCP-specific: the McpServer, metrics instrumentation,
 * the sync probe, the surface gates, and the dashboard dependency bundle.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PKG_VERSION } from "./version.js";
import { createTwiningContext, type TwiningContext } from "./core/context.js";
import { attachSyncProbe } from "./storage/sync/sync-manager.js";
import { registerBlackboardTools } from "./tools/blackboard-tools.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerContextTools } from "./tools/context-tools.js";
import { registerRecordTools } from "./tools/record-tools.js";
import { registerLifecycleTools } from "./tools/lifecycle-tools.js";
import { registerGraphTools } from "./tools/graph-tools.js";
import { registerVerifyTools } from "./tools/verify-tools.js";
import { registerTriageTools } from "./tools/triage-tools.js";
import { registerExportTools } from "./tools/export-tools.js";
import { registerCoordinationTools } from "./tools/coordination-tools.js";
import { registerHousekeepingTools } from "./tools/housekeeping-tools.js";
import { MetricsCollector } from "./analytics/metrics-collector.js";
import { createInstrumentedServer } from "./analytics/instrumented-server.js";
import { TWINING_INSTRUCTIONS } from "./instructions.js";
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
  /** Close the sqlite handle (sqlite checkpoints its WAL on close — S4-7).
   * No-op on the files backend. Registered against process exit in index.ts. */
  closeDb: () => void;
  /** The transport-agnostic stack this server is a front end for. */
  ctx: TwiningContext;
}

export function createServer(projectRoot: string): ServerContext {
  const ctx = createTwiningContext(projectRoot);
  const { twiningDir, config } = ctx;

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
  if (ctx.recordSync) {
    attachSyncProbe(server, ctx.recordSync);
  }

  // Register tools — full_surface=false (default) hides rarely-used tools to reduce noise.
  // Claude Code defers tool loading via ToolSearch, so hidden tools don't appear in search.
  const toolMode = ctx.toolMode;
  const fullSurface = ctx.fullSurface;

  // Core tools (always registered in both full and lite modes)
  registerRecordTools(
    server,
    ctx.blackboardEngine,
    ctx.decisionEngine,
    projectRoot,
    twiningDir,
    { fullSurface },
  );
  registerHousekeepingTools(
    server,
    ctx.housekeepingEngine,
    ctx.blackboardEngine,
    ctx.decisionStore,
    twiningDir,
  );
  registerBlackboardTools(server, ctx.blackboardEngine, twiningDir, {
    fullSurface,
    decisionEngine: ctx.decisionEngine,
    decisionStore: ctx.decisionStore,
  });
  registerDecisionTools(server, ctx.decisionEngine, twiningDir, { fullSurface });
  registerContextTools(server, ctx.contextAssembler, { fullSurface });
  if (fullSurface) {
    registerVerifyTools(server, ctx.verifyEngine);
  }
  registerCoordinationTools(
    server,
    ctx.agentStore,
    ctx.coordinationEngine,
    config,
    ctx.graphPopulator,
    { fullSurface },
  );

  // Export tools only in full surface mode
  if (fullSurface) {
    registerExportTools(server, ctx.exporter);
  }

  // Triage tool only in full surface mode in v1 (TRIAGE-SPEC §6)
  if (fullSurface) {
    registerTriageTools(server, {
      decisionStore: ctx.decisionStore,
      blackboardStore: ctx.blackboardStore,
    });
  }

  // Extended tools (full mode only)
  if (toolMode === "full") {
    registerLifecycleTools(
      server,
      twiningDir,
      ctx.blackboardStore,
      ctx.decisionStore,
      ctx.graphStore,
      ctx.archiver,
      config,
      ctx.agentStore,
      ctx.identity,
    );
    registerGraphTools(server, ctx.graphEngine);
  }

  return {
    server,
    metricsCollector,
    twiningDir,
    config,
    dashboardDeps: ctx.dashboardDeps,
    closeDb: ctx.closeDb,
    ctx,
  };
}
