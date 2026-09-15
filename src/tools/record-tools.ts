/**
 * MCP registration for twining_record — the unified recording tool.
 * Handler lives in src/core/commands/record.ts (2.17.0).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BlackboardEngine } from "../engine/blackboard.js";
import type { DecisionEngine } from "../engine/decisions.js";
import { registerCommands } from "../core/command-def.js";
import { recordCommands, type RecordCtx } from "../core/commands/record.js";

export function registerRecordTools(
  server: McpServer,
  blackboardEngine: BlackboardEngine,
  decisionEngine: DecisionEngine,
  projectRoot: string,
  twiningDir: string,
  options: { fullSurface?: boolean } = {},
): void {
  const ctx: RecordCtx = {
    blackboardEngine,
    decisionEngine,
    projectRoot,
    twiningDir,
    fullSurface: options.fullSurface ?? false,
  };
  // twining_record is a default-surface command, so it registers either way;
  // options.fullSurface gates provisional MINTING inside the handler.
  registerCommands(server, ctx, recordCommands, {
    fullSurface: options.fullSurface,
  });
}
