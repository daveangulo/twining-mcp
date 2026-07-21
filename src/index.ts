#!/usr/bin/env node
/**
 * Twining MCP Server entry point.
 * Connects via stdio transport — never use console.log (corrupts JSON-RPC).
 */
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startDashboard, setupDashboardShutdown } from "./dashboard/http-server.js";
import { TelemetryClient } from "./analytics/telemetry-client.js";
import { resolveProjectRoot } from "./utils/project-root.js";

// Handle --version / -v before starting the MCP server
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const require = createRequire(import.meta.url);
  const { version } = require("../package.json") as { version: string };
  console.log(`twining-mcp ${version}`);
  process.exit(0);
}

// Explicit CLI subcommand — exits before the MCP stdio transport starts, so
// console.log is safe on this path. Runs even under TWINING_DISABLED:
// migration is a deliberate act.
if (process.argv[2] === "migrate") {
  const { runMigrateCli } = await import("./migrate/cli.js");
  process.exit(await runMigrateCli(process.argv.slice(3)));
}

async function main(): Promise<void> {
  if (process.env.TWINING_DISABLED === "true") {
    process.exit(0);
  }

  // Project root: --project arg > TWINING_PROJECT env > cwd (#46). The env
  // var lets the plugin-contributed server target a shared store without a
  // per-repo .mcp.json override or a brittle deniedMcpServers block.
  const projectRoot = resolveProjectRoot(
    process.argv,
    process.env,
    process.cwd(),
  );

  // Opt-in only (TWINING_AUTO_MIGRATE=1 / storage.auto_migrate) — the
  // default path for legacy projects is the createStores nudge.
  const { maybeAutoMigrate } = await import("./migrate/auto.js");
  await maybeAutoMigrate(projectRoot);

  const { server, metricsCollector, config, dashboardDeps } = createServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Initialize opt-in telemetry (fire-and-forget)
  const telemetry = new TelemetryClient();
  const pkgVersion = (server as unknown as { serverInfo?: { version?: string } })
    .serverInfo?.version || "unknown";
  telemetry.init(config.analytics, projectRoot, pkgVersion).then((enabled) => {
    if (enabled) {
      metricsCollector.setTelemetryClient(telemetry);

      // Session summary every 5 minutes (unref so it doesn't keep process alive)
      const summaryTimer = setInterval(() => {
        // Lightweight: just sends aggregate counts, no content
        telemetry.trackSessionSummary({}, 0, 0);
      }, 5 * 60 * 1000);
      summaryTimer.unref();
    }
  }).catch(() => {
    // Telemetry init failure is always non-fatal
  });

  // Graceful shutdown for telemetry
  process.on("beforeExit", () => {
    telemetry.shutdown().catch(() => {});
  });

  // Start dashboard HTTP server (fire-and-forget — never blocks MCP).
  // Shares the server's stores and engines so the dashboard reads through the
  // same caches and embedder instead of wiring a parallel stack.
  startDashboard(projectRoot, dashboardDeps).then((result) => {
    if (result) {
      setupDashboardShutdown(result.server);
    }
  }).catch((err) => {
    console.error("[twining] Dashboard failed to start (non-fatal):", (err as Error).message);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
