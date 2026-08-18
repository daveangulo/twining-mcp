#!/usr/bin/env node
/**
 * Twining MCP Server entry point.
 * Connects via stdio transport — never use console.log (corrupts JSON-RPC).
 */
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startDashboard } from "./dashboard/http-server.js";
import { TelemetryClient } from "./analytics/telemetry-client.js";
import { resolveProjectRoot } from "./utils/project-root.js";

// Handle --version / -v before starting the MCP server.
// __TWINING_VERSION__ is baked in by the bundle build (relocation-safe);
// the tsc build falls back to the package.json lookup relative to dist/.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const version =
    typeof __TWINING_VERSION__ !== "undefined"
      ? __TWINING_VERSION__
      : (createRequire(import.meta.url)("../package.json") as { version: string }).version;
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

  const { server, metricsCollector, config, dashboardDeps, closeDb } = createServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Coordinated shutdown (S4-7 + 2.16.0 review LS-2/LS-3): one path for
  // signals and stdin close. On a signal: stop accepting dashboard
  // connections, give in-flight tool steps the same bounded 3s drain the
  // previous dashboard-only handler provided (an immediate exit truncated
  // multi-step writes mid-await), then exit with the conventional signal
  // code. Closing the db lives on 'exit' so it runs exactly once on every
  // termination path node can observe — close checkpoints the WAL.
  let dashboardServer: import("node:http").Server | null = null;
  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = code;
    try {
      dashboardServer?.close(() => {});
    } catch {
      // Already closed — nothing to drain.
    }
    const timer = setTimeout(() => {
      process.exit(code);
    }, 3000);
    timer.unref();
  };
  process.once("exit", () => closeDb());
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  // Stdio hosts that end the session by closing stdin never send a signal —
  // without this, the dashboard's ref'd socket keeps the process alive
  // serving nothing, and the WAL stays uncheckpointed (review LS-2).
  process.stdin.once("end", () => shutdown(0));
  process.stdin.once("close", () => shutdown(0));

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
      // Handed to the unified shutdown above — setupDashboardShutdown's own
      // signal handlers are superseded by it (2.16.0 review LS-3): two
      // competing handlers meant the first exit() truncated the other's
      // drain, and its exit(0) hid the signal from supervisors.
      dashboardServer = result.server;
    }
  }).catch((err) => {
    console.error("[twining] Dashboard failed to start (non-fatal):", (err as Error).message);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
