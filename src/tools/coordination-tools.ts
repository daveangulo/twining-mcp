/**
 * MCP registration for the agent-coordination commands.
 * Handlers live in src/core/commands/coordination.ts (2.17.0).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CoordinationEngine } from "../engine/coordination.js";
import type { TwiningConfig } from "../utils/types.js";
import type { GraphAutoPopulator } from "../engine/graph-auto-populator.js";
import type { IAgentStore } from "../storage/interfaces.js";
import { registerCommands } from "../core/command-def.js";
import {
  coordinationCommands,
  type CoordinationCtx,
} from "../core/commands/coordination.js";

export function registerCoordinationTools(
  server: McpServer,
  agentStore: IAgentStore,
  coordinationEngine: CoordinationEngine,
  config: TwiningConfig,
  graphPopulator?: GraphAutoPopulator | null,
  options: { fullSurface?: boolean } = {},
): void {
  const ctx: CoordinationCtx = {
    agentStore,
    coordinationEngine,
    config,
    graphPopulator,
  };
  registerCommands(server, ctx, coordinationCommands, {
    fullSurface: options.fullSurface,
  });
}
