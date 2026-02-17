#!/usr/bin/env node
/**
 * Twining MCP Server entry point.
 * Connects via stdio transport — never use console.log (corrupts JSON-RPC).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startDashboard, setupDashboardShutdown } from "./dashboard/http-server.js";

async function main(): Promise<void> {
  // Parse --project argument, default to cwd
  let projectRoot = process.cwd();
  const projectArgIndex = process.argv.indexOf("--project");
  if (projectArgIndex !== -1 && process.argv[projectArgIndex + 1]) {
    projectRoot = process.argv[projectArgIndex + 1]!;
  }

  const server = createServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);

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
