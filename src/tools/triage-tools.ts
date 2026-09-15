/**
 * MCP registration for twining_triage (docs/TRIAGE-SPEC.md §6).
 * Handler lives in src/core/commands/triage.ts (2.17.0).
 * Module gated at the call site (`if (fullSurface)` in createServer).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TriageStores } from "../engine/triage.js";
import { registerCommands } from "../core/command-def.js";
import { triageCommands } from "../core/commands/triage.js";

export function registerTriageTools(
  server: McpServer,
  stores: TriageStores,
): void {
  registerCommands(server, stores, triageCommands, { fullSurface: true });
}
