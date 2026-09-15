/**
 * MCP registration for the lifecycle commands (twining_status, twining_archive).
 * Handlers live in src/core/commands/lifecycle.ts (2.17.0).
 * Module gated at the call site (`if (toolMode === "full")` in createServer).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Archiver } from "../engine/archiver.js";
import type { TwiningConfig } from "../utils/types.js";
import type {
  IAgentStore,
  IBlackboardStore,
  IDecisionStore,
  IGraphStore,
} from "../storage/interfaces.js";
import { registerCommands } from "../core/command-def.js";
import {
  lifecycleCommands,
  type LifecycleCtx,
  type ServerIdentity,
} from "../core/commands/lifecycle.js";

export type { ServerIdentity } from "../core/commands/lifecycle.js";

export function registerLifecycleTools(
  server: McpServer,
  twiningDir: string,
  blackboardStore: IBlackboardStore,
  decisionStore: IDecisionStore,
  graphStore: IGraphStore,
  archiver: Archiver,
  config: TwiningConfig,
  agentStore: IAgentStore | null = null,
  identity: ServerIdentity = {},
): void {
  const ctx: LifecycleCtx = {
    twiningDir,
    blackboardStore,
    decisionStore,
    graphStore,
    archiver,
    config,
    agentStore,
    identity,
  };
  // Both lifecycle commands are default-surface within the "full" tool mode.
  registerCommands(server, ctx, lifecycleCommands);
}
