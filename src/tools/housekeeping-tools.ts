/**
 * MCP registration for the housekeeping commands — periodic store maintenance
 * and stale-item archival. Both mutating tools are dry-run by default.
 * Handlers live in src/core/commands/housekeeping.ts (2.17.0).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HousekeepingEngine } from "../engine/housekeeping.js";
import type { BlackboardEngine } from "../engine/blackboard.js";
import type { IDecisionStore } from "../storage/interfaces.js";
import { registerCommands } from "../core/command-def.js";
import {
  housekeepingCommands,
  type HousekeepingCtx,
} from "../core/commands/housekeeping.js";

export function registerHousekeepingTools(
  server: McpServer,
  housekeepingEngine: HousekeepingEngine,
  blackboardEngine: BlackboardEngine,
  decisionStore: IDecisionStore,
  twiningDir: string,
): void {
  const ctx: HousekeepingCtx = {
    housekeepingEngine,
    blackboardEngine,
    decisionStore,
    twiningDir,
  };
  // All three housekeeping commands are default-surface.
  registerCommands(server, ctx, housekeepingCommands);
}
