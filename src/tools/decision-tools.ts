/**
 * MCP registration for the decision commands.
 * Handlers live in src/core/commands/decisions.ts (2.17.0).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionEngine } from "../engine/decisions.js";
import { registerCommands } from "../core/command-def.js";
import { decisionCommands, type DecisionCtx } from "../core/commands/decisions.js";

export function registerDecisionTools(
  server: McpServer,
  engine: DecisionEngine,
  twiningDir: string,
  options: { fullSurface?: boolean } = {},
): void {
  const ctx: DecisionCtx = { decisionEngine: engine, twiningDir };
  registerCommands(server, ctx, decisionCommands, {
    fullSurface: options.fullSurface,
  });
}
