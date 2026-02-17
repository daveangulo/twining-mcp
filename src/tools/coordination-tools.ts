/**
 * MCP tool handlers for agent coordination operations.
 * Registers twining_agents for querying the agent registry with liveness.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentStore } from "../storage/agent-store.js";
import type { CoordinationEngine } from "../engine/coordination.js";
import type { TwiningConfig } from "../utils/types.js";
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
} from "../utils/liveness.js";
import { toolResult, toolError } from "../utils/errors.js";

export function registerCoordinationTools(
  server: McpServer,
  agentStore: AgentStore,
  coordinationEngine: CoordinationEngine,
  config: TwiningConfig,
): void {
  // twining_agents — List all registered agents with liveness status
  server.registerTool(
    "twining_agents",
    {
      description:
        "List all registered agents with their capabilities and liveness status.",
      inputSchema: {
        include_gone: z
          .boolean()
          .optional()
          .describe(
            "Whether to include gone agents (default: true)",
          ),
      },
    },
    async (args) => {
      try {
        const includeGone = args.include_gone ?? true;
        const agents = await agentStore.getAll();
        const thresholds =
          config.agents?.liveness ?? DEFAULT_LIVENESS_THRESHOLDS;
        const now = new Date();

        const mapped = agents.map((agent) => ({
          agent_id: agent.agent_id,
          capabilities: agent.capabilities,
          role: agent.role,
          description: agent.description,
          registered_at: agent.registered_at,
          last_active: agent.last_active,
          liveness: computeLiveness(agent.last_active, now, thresholds),
        }));

        const filtered = includeGone
          ? mapped
          : mapped.filter((a) => a.liveness !== "gone");

        const activeCount = mapped.filter(
          (a) => a.liveness === "active",
        ).length;

        return toolResult({
          agents: filtered,
          total_registered: agents.length,
          active_count: activeCount,
        });
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );
}
