#!/usr/bin/env node
/**
 * Twining MCP Server entry point.
 * Connects via stdio transport — never use console.log (corrupts JSON-RPC).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startDashboard, setupDashboardShutdown } from "./dashboard/http-server.js";
import { TelemetryClient } from "./analytics/telemetry-client.js";

async function main(): Promise<void> {
  // Parse --project argument, default to cwd
  let projectRoot = process.cwd();
  const projectArgIndex = process.argv.indexOf("--project");
  if (projectArgIndex !== -1 && process.argv[projectArgIndex + 1]) {
    projectRoot = process.argv[projectArgIndex + 1]!;
  }

  const { server, metricsCollector, config } = createServer(projectRoot);
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

  // Start dashboard HTTP server (fire-and-forget — never blocks MCP)
  startDashboard(projectRoot).then((result) => {
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
