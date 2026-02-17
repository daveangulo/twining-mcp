/**
 * MCP tool handlers for lifecycle operations.
 * Registers twining_status (enhanced with graph counts and warnings) and twining_archive.
 */
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import type { GraphStore } from "../storage/graph-store.js";
import type { AgentStore } from "../storage/agent-store.js";
import type { Archiver } from "../engine/archiver.js";
import type { TwiningConfig } from "../utils/types.js";
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
} from "../utils/liveness.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerLifecycleTools(
  server: McpServer,
  twiningDir: string,
  blackboardStore: BlackboardStore,
  decisionStore: DecisionStore,
  graphStore: GraphStore,
  archiver: Archiver,
  config: TwiningConfig,
  agentStore: AgentStore | null = null,
): void {
  // twining_status — Overall health check of the Twining state
  server.registerTool(
    "twining_status",
    {
      description:
        "Overall health check of the Twining state. Shows blackboard entry count, decision counts, graph entity/relation counts, actionable warnings, and a human-readable summary.",
    },
    async () => {
      try {
        // Get project name from parent directory
        const projectRoot = path.dirname(twiningDir);
        const project = path.basename(projectRoot);

        // Count blackboard entries
        const { total_count: blackboard_entries } =
          await blackboardStore.read();

        // Count decisions by status
        const index = await decisionStore.getIndex();
        const active_decisions = index.filter(
          (e) => e.status === "active",
        ).length;
        const provisional_decisions = index.filter(
          (e) => e.status === "provisional",
        ).length;

        // Graph counts
        const entities = await graphStore.getEntities();
        const relations = await graphStore.getRelations();
        const graph_entities = entities.length;
        const graph_relations = relations.length;

        // Find last activity timestamp
        const recentEntries = await blackboardStore.recent(1);
        const lastBBActivity =
          recentEntries.length > 0 ? recentEntries[0]!.timestamp : null;
        const lastDecisionActivity =
          index.length > 0
            ? index.reduce((latest, e) =>
                e.timestamp > latest ? e.timestamp : latest,
              index[0]!.timestamp)
            : null;

        let last_activity = "none";
        if (lastBBActivity && lastDecisionActivity) {
          last_activity =
            lastBBActivity > lastDecisionActivity
              ? lastBBActivity
              : lastDecisionActivity;
        } else if (lastBBActivity) {
          last_activity = lastBBActivity;
        } else if (lastDecisionActivity) {
          last_activity = lastDecisionActivity;
        }

        // Archiving threshold
        const archiveThreshold =
          config.archive.max_blackboard_entries_before_archive;
        const needs_archiving = blackboard_entries >= archiveThreshold;

        // Actionable warnings
        const warnings: string[] = [];

        // Stale provisionals: older than 7 days
        const sevenDaysAgo = new Date(
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const staleProvisionals = index.filter(
          (e) =>
            e.status === "provisional" && e.timestamp < sevenDaysAgo,
        );
        if (staleProvisionals.length > 0) {
          warnings.push(
            `${staleProvisionals.length} provisional decisions older than 7 days need resolution`,
          );
        }

        // Archive needed
        if (needs_archiving) {
          warnings.push(
            `Blackboard has ${blackboard_entries} entries, archive recommended (threshold: ${archiveThreshold})`,
          );
        }

        // Orphan entities: entities with zero relations
        if (graph_entities > 0) {
          const entityIds = new Set(entities.map((e) => e.id));
          const connectedIds = new Set<string>();
          for (const r of relations) {
            connectedIds.add(r.source);
            connectedIds.add(r.target);
          }
          const orphanCount = [...entityIds].filter(
            (id) => !connectedIds.has(id),
          ).length;
          if (orphanCount > 0) {
            warnings.push(
              `${orphanCount} graph entities have no relations`,
            );
          }
        }

        // Agent counts
        let registered_agents = 0;
        let active_agents = 0;
        if (agentStore) {
          const agents = await agentStore.getAll();
          registered_agents = agents.length;
          const thresholds =
            config.agents?.liveness ?? DEFAULT_LIVENESS_THRESHOLDS;
          const now = new Date();
          active_agents = agents.filter(
            (a) =>
              computeLiveness(a.last_active, now, thresholds) === "active",
          ).length;
        }

        // Build summary string
        const healthStatus =
          warnings.length === 0 ? "Healthy" : "Needs attention";
        const warningsSummary =
          warnings.length > 0 ? ` ${warnings.join(". ")}.` : "";
        const agentSummary = ` ${registered_agents} registered agents (${active_agents} active).`;
        const summary = `${healthStatus}. ${blackboard_entries} blackboard entries, ${active_decisions} active decisions, ${graph_entities} graph entities.${agentSummary}${warningsSummary}`;

        return toolResult({
          project,
          blackboard_entries,
          active_decisions,
          provisional_decisions,
          graph_entities,
          graph_relations,
          registered_agents,
          active_agents,
          last_activity,
          needs_archiving,
          warnings,
          summary,
        });
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_archive — Archive old blackboard entries
  server.registerTool(
    "twining_archive",
    {
      description:
        "Archive old blackboard entries. Moves entries older than a cutoff timestamp to an archive file, preserving decision entries. Optionally posts a summary finding.",
      inputSchema: {
        before: z
          .string()
          .optional()
          .describe("ISO timestamp cutoff — archive entries before this time (default: now)"),
        keep_decisions: z
          .boolean()
          .optional()
          .describe("Whether to keep decision entries in the blackboard (default: true)"),
        summarize: z
          .boolean()
          .optional()
          .describe("Whether to post a summary finding after archiving (default: true)"),
      },
    },
    async (args) => {
      try {
        const result = await archiver.archive(args);
        return toolResult(result);
      } catch (e) {
        if (e instanceof TwiningError) {
          return toolError(e.message, e.code);
        }
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );
}
