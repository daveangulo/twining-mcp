/**
 * MCP registration for the exchange observability command (R20).
 * Handler lives in src/core/commands/exchange.ts (lane 02b).
 *
 * The command is default-surface: "what is this replica uncertain about?" must
 * be askable without an operator widening the tool surface first.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCommands } from "../core/command-def.js";
import { exchangeCommands, type ExchangeCtx } from "../core/commands/exchange.js";

export function registerExchangeTools(
  server: McpServer,
  twiningDir: string,
  options: { fullSurface?: boolean } = {},
): void {
  const ctx: ExchangeCtx = { twiningDir };
  registerCommands(server, ctx, exchangeCommands, {
    fullSurface: options.fullSurface,
  });
}
