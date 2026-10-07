/**
 * MCP registration for twining_export.
 * Handler lives in src/core/commands/export.ts (2.17.0).
 * Module gated at the call site (`if (fullSurface)` in createServer).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Exporter } from "../engine/exporter.js";
import { registerCommands } from "../core/command-def.js";
import { exportCommands, type ExportCtx } from "../core/commands/export.js";

export function registerExportTools(
  server: McpServer,
  exporter: Exporter,
): void {
  const ctx: ExportCtx = { exporter };
  registerCommands(server, ctx, exportCommands, { fullSurface: true });
}
