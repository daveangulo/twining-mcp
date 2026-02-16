#!/usr/bin/env node
/**
 * Twining MCP Server entry point.
 * Connects via stdio transport — never use console.log (corrupts JSON-RPC).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

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
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
