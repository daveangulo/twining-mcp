/**
 * MCP registration for the knowledge-graph commands.
 * Handlers live in src/core/commands/graph.ts (2.17.0).
 * Module gated at the call site (`if (toolMode === "full")` in createServer).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphEngine } from "../engine/graph.js";
import { registerCommands } from "../core/command-def.js";
import { graphCommands, type GraphCtx } from "../core/commands/graph.js";

export function registerGraphTools(
  server: McpServer,
  engine: GraphEngine,
): void {
  const ctx: GraphCtx = { graphEngine: engine };
  // All graph commands are default-surface within the "full" tool mode.
  registerCommands(server, ctx, graphCommands);
}
