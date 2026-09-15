/**
 * MCP registration for twining_verify.
 * Handler lives in src/core/commands/verify.ts (2.17.0).
 *
 * The whole module is gated at the call site (`if (fullSurface)` in
 * createServer), matching the pre-2.17 shape.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VerifyEngine } from "../engine/verify.js";
import { registerCommands } from "../core/command-def.js";
import { verifyCommands, type VerifyCtx } from "../core/commands/verify.js";

export function registerVerifyTools(
  server: McpServer,
  verifyEngine: VerifyEngine,
): void {
  const ctx: VerifyCtx = { verifyEngine };
  registerCommands(server, ctx, verifyCommands, { fullSurface: true });
}
