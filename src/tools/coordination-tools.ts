/**
 * MCP tool handlers for agent coordination operations.
 * Registers twining_agents, twining_discover, twining_delegate,
 * twining_handoff, and twining_acknowledge.
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

  // twining_discover — Find agents matching required capabilities
  server.registerTool(
    "twining_discover",
    {
      description:
        "Find agents matching required capabilities, ranked by capability overlap and liveness. Returns scored agent list for delegation decisions.",
      inputSchema: {
        required_capabilities: z
          .array(z.string())
          .describe("Capabilities the agent must have (e.g. ['testing', 'typescript'])"),
        include_gone: z
          .boolean()
          .optional()
          .describe("Whether to include gone agents (default: true)"),
        min_score: z
          .number()
          .optional()
          .describe("Minimum total_score threshold (default: 0)"),
      },
    },
    async (args) => {
      try {
        const result = await coordinationEngine.discover({
          required_capabilities: args.required_capabilities,
          include_gone: args.include_gone,
          min_score: args.min_score,
        });
        return toolResult(result);
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_delegate — Post a delegation request to the blackboard
  server.registerTool(
    "twining_delegate",
    {
      description:
        "Post a delegation request to the blackboard as a 'need' entry with capability requirements. Returns suggested agents ranked by match quality.",
      inputSchema: {
        summary: z
          .string()
          .describe("Description of the task to delegate (max 200 chars)"),
        required_capabilities: z
          .array(z.string())
          .describe("Capabilities needed for this task"),
        urgency: z
          .enum(["high", "normal", "low"])
          .optional()
          .describe("Urgency level affecting timeout (default: 'normal')"),
        timeout_ms: z
          .number()
          .optional()
          .describe("Custom timeout in ms (overrides urgency-based default)"),
        scope: z
          .string()
          .optional()
          .describe("Scope for the delegation (default: 'project')"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Additional tags for the delegation entry"),
        agent_id: z
          .string()
          .optional()
          .describe("ID of the delegating agent (default: 'main')"),
      },
    },
    async (args) => {
      try {
        const result = await coordinationEngine.postDelegation({
          summary: args.summary,
          required_capabilities: args.required_capabilities,
          urgency: args.urgency,
          timeout_ms: args.timeout_ms,
          scope: args.scope,
          tags: args.tags,
          agent_id: args.agent_id,
        });
        return toolResult(result);
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_handoff — Create a handoff between agents
  server.registerTool(
    "twining_handoff",
    {
      description:
        "Create a handoff record from one agent to another, capturing work results and auto-assembling context snapshot. Posts a status entry to the blackboard.",
      inputSchema: {
        source_agent: z
          .string()
          .describe("ID of the agent handing off work"),
        target_agent: z
          .string()
          .optional()
          .describe("ID of the target agent (omit for open handoff to any agent)"),
        scope: z
          .string()
          .optional()
          .describe("Scope of the handoff (default: 'project')"),
        summary: z
          .string()
          .describe("Summary of work being handed off"),
        results: z
          .array(
            z.object({
              description: z.string().describe("What was done"),
              status: z
                .enum(["completed", "partial", "blocked", "failed"])
                .describe("Result status"),
              artifacts: z
                .array(z.string())
                .optional()
                .describe("File paths or artifact IDs produced"),
              notes: z
                .string()
                .optional()
                .describe("Additional notes"),
            }),
          )
          .describe("Results of the work being handed off"),
        auto_snapshot: z
          .boolean()
          .optional()
          .describe("Auto-assemble context snapshot from decisions/warnings (default: true)"),
      },
    },
    async (args) => {
      try {
        const record = await coordinationEngine.createHandoff({
          source_agent: args.source_agent,
          target_agent: args.target_agent,
          scope: args.scope,
          summary: args.summary,
          results: args.results,
          auto_snapshot: args.auto_snapshot,
        });
        return toolResult({
          id: record.id,
          created_at: record.created_at,
          source_agent: record.source_agent,
          target_agent: record.target_agent,
          scope: record.scope,
          summary: record.summary,
          result_count: record.results.length,
          context_snapshot_size: {
            decisions: record.context_snapshot.decision_ids.length,
            warnings: record.context_snapshot.warning_ids.length,
            findings: record.context_snapshot.finding_ids.length,
          },
        });
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_acknowledge — Acknowledge receipt of a handoff
  server.registerTool(
    "twining_acknowledge",
    {
      description:
        "Acknowledge receipt of a handoff, recording which agent picked it up.",
      inputSchema: {
        handoff_id: z
          .string()
          .describe("ID of the handoff to acknowledge"),
        agent_id: z
          .string()
          .describe("ID of the agent acknowledging the handoff"),
      },
    },
    async (args) => {
      try {
        const record = await coordinationEngine.acknowledgeHandoff(
          args.handoff_id,
          args.agent_id,
        );
        return toolResult({
          id: record.id,
          acknowledged_by: record.acknowledged_by,
          acknowledged_at: record.acknowledged_at,
          summary: record.summary,
          source_agent: record.source_agent,
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
