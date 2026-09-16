/**
 * MCP registration for the blackboard commands.
 * The handlers live in src/core/commands/blackboard.ts (2.17.0) — this file
 * maps them onto server.registerTool with the surface gate and the
 * toolResult/toolError envelope.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BlackboardEngine } from "../engine/blackboard.js";
import type { DecisionEngine } from "../engine/decisions.js";
import type { IDecisionStore } from "../storage/interfaces.js";
import { registerCommands } from "../core/command-def.js";
import { blackboardCommands, type BlackboardCtx } from "../core/commands/blackboard.js";

export function registerBlackboardTools(
  server: McpServer,
  engine: BlackboardEngine,
  twiningDir: string,
  options: {
    fullSurface?: boolean;
    // Decisions live only in the decision store (issue #30) — query/recent
    // merge decision-store results into their output when these are provided.
    decisionEngine?: DecisionEngine;
    decisionStore?: IDecisionStore;
  } = {},
): void {
  const ctx: BlackboardCtx = {
    blackboardEngine: engine,
    twiningDir,
    decisionEngine: options.decisionEngine,
    decisionStore: options.decisionStore,
  };
  registerCommands(server, ctx, blackboardCommands, {
    fullSurface: options.fullSurface,
  });
}
