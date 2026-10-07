/**
 * MCP registration for the migration READ surface (lane 02c).
 *
 * Only `twining_migrate_status` is here, and deliberately: the migration verbs
 * themselves (`twining migrate --to 3`, `twining rollback --to 2`) rewrite the
 * store's on-disk format, and a format change fired from inside an agent's
 * tool loop — mid-session, possibly alongside another agent's writes — is the
 * class of action the ADR keeps behind an explicit operator verb (§8.2 says
 * the same about `twining sync`). Reading that state is safe; changing it is
 * the operator's call.
 *
 * Handler lives in src/core/commands/migrate.ts; this is a registration loop.
 * Module gated at the call site (`if (fullSurface)` in createServer).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCommands } from "../core/command-def.js";
import { migrateCommands, type MigrateCtx } from "../core/commands/migrate.js";

export function registerMigrateTools(server: McpServer, twiningDir: string): void {
  const ctx: MigrateCtx = { twiningDir };
  registerCommands(server, ctx, migrateCommands, { fullSurface: true });
}
