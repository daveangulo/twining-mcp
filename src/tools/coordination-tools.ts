/**
 * MCP tool handlers for agent coordination operations.
 * Registers twining_agents, twining_register, twining_discover,
 * twining_delegate, twining_handoff, and twining_acknowledge.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CoordinationEngine } from "../engine/coordination.js";
import type { TwiningConfig } from "../utils/types.js";
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
} from "../utils/liveness.js";
import { toolResult, toolError } from "../utils/errors.js";
import type { GraphAutoPopulator } from "../engine/graph-auto-populator.js";
import type { IAgentStore } from "../storage/interfaces.js";

export function registerCoordinationTools(
  server: McpServer,
  agentStore: IAgentStore,
  coordinationEngine: CoordinationEngine,
  config: TwiningConfig,
  graphPopulator?: GraphAutoPopulator | null,
  options: { fullSurface?: boolean } = {},
): void {
  // twining_agents — List all registered agents with liveness status (full surface only)
  if (options.fullSurface) server.registerTool(
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

  // twining_register — Register or update an agent in the registry (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_register",
    {
      description:
        "Register a new agent or update an existing one. Merges capabilities on re-registration. Use this to make subagents visible in the coordination dashboard.",
      inputSchema: {
        agent_id: z
          .string()
          .describe("Unique identifier for the agent (e.g. 'code-reviewer', 'test-runner')"),
        capabilities: z
          .array(z.string())
          .optional()
          .describe("Agent capabilities (e.g. ['testing', 'typescript'])"),
        role: z
          .string()
          .optional()
          .describe("Agent role (e.g. 'reviewer', 'implementer')"),
        description: z
          .string()
          .optional()
          .describe("Human-readable description of what the agent does"),
      },
    },
    async (args) => {
      try {
        const record = await agentStore.upsert({
          agent_id: args.agent_id,
          capabilities: args.capabilities,
          role: args.role,
          description: args.description,
        });
        // Auto-populate graph with agent entity
        if (graphPopulator) {
          await graphPopulator.onRegister(args.agent_id, args.capabilities, args.role);
        }
        return toolResult({
          agent_id: record.agent_id,
          capabilities: record.capabilities,
          role: record.role,
          description: record.description,
          registered_at: record.registered_at,
          last_active: record.last_active,
        });
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_discover — Find agents matching required capabilities (full surface only)
  if (options.fullSurface) server.registerTool(
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
          .describe(
            "Minimum total_score threshold. When unset (default) and required_capabilities is non-empty, agents with zero capability overlap are excluded and counted in excluded_zero_overlap; pass 0 explicitly to list every registered agent regardless of overlap. With an empty required_capabilities list, nothing is excluded.",
          ),
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

  // twining_delegate — Post a delegation request to the blackboard (full surface only)
  if (options.fullSurface) server.registerTool(
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

  // twining_handoff — Create a handoff between agents (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_handoff",
    {
      description:
        "DEPRECATED — scheduled for removal in v3 (#33): field data shows real handoffs are rich committed markdown docs, which this structured API is too shallow to carry. Prefer writing a handoff doc, committing it, and posting an 'artifact' entry via twining_post with the doc path so the next session's assemble surfaces it. Hand off work to another agent with structured results and context.",
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
        // Auto-populate graph with handoff entities/relations
        if (graphPopulator) {
          await graphPopulator.onHandoff({
            source_agent: args.source_agent,
            target_agent: args.target_agent,
            scope: args.scope,
            results: args.results,
          });
        }
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

  // twining_acknowledge — Acknowledge receipt of a handoff (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_acknowledge",
    {
      description:
        "DEPRECATED — scheduled for removal in v3 alongside twining_handoff (#33). Acknowledge receipt of a handoff, recording which agent picked it up.",
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
