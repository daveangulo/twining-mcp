/**
 * MCP tool handlers for lifecycle operations.
 * Registers twining_status.
 */
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { toolResult, toolError } from "../utils/errors.js";

export function registerLifecycleTools(
  server: McpServer,
  twiningDir: string,
  blackboardStore: BlackboardStore,
  decisionStore: DecisionStore,
): void {
  // twining_status — Overall health check of the Twining state
  server.registerTool(
    "twining_status",
    {
      description:
        "Overall health check of the Twining state. Shows blackboard entry count, decision counts, and whether archiving is needed.",
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

        // Archiving threshold: 500 entries (from default config)
        const needs_archiving = blackboard_entries >= 500;

        return toolResult({
          project,
          blackboard_entries,
          active_decisions,
          provisional_decisions,
          graph_entities: 0, // Not implemented in Phase 1
          graph_relations: 0, // Not implemented in Phase 1
          last_activity,
          needs_archiving,
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
