/**
 * MCP registration for the context-assembly commands.
 * Handlers live in src/core/commands/context.ts (2.17.0).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextAssembler } from "../engine/context-assembler.js";
import { registerCommands } from "../core/command-def.js";
import { contextCommands, type ContextCtx } from "../core/commands/context.js";

export function registerContextTools(
  server: McpServer,
  contextAssembler: ContextAssembler,
  options: { fullSurface?: boolean } = {},
): void {
  const ctx: ContextCtx = { contextAssembler };
  registerCommands(server, ctx, contextCommands, {
    fullSurface: options.fullSurface,
  });
}
