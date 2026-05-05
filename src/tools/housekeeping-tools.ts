/**
 * MCP tool handlers for housekeeping — periodic store maintenance and
 * stale-item archival. Both tools are dry-run by default.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HousekeepingEngine } from "../engine/housekeeping.js";
import type { BlackboardEngine } from "../engine/blackboard.js";
import type { DecisionStore } from "../storage/decision-store.js";
import { toolResult, toolError } from "../utils/errors.js";

export function registerHousekeepingTools(
  server: McpServer,
  housekeepingEngine: HousekeepingEngine,
  blackboardEngine: BlackboardEngine,
  decisionStore: DecisionStore,
): void {
  server.registerTool(
    "twining_housekeeping",
    {
      description:
        "Run periodic maintenance on Twining stores. Preview by default (dry run). " +
        "Archives old entries, removes duplicates, surfaces stale decisions and dangling warnings, " +
        "prunes orphaned graph entities, and rotates old metrics. " +
        "Pass staleness_review: true to also flag entries whose scope/files/branch are gone. " +
        "Pass execute: true to apply changes.",
      inputSchema: {
        execute: z
          .boolean()
          .optional()
          .describe("Set to true to apply changes. Default is false (preview only)."),
        promote_provisionals: z
          .boolean()
          .optional()
          .describe("Set to true to auto-promote stale provisional decisions to active. Default is false (report only)."),
        staleness_review: z
          .boolean()
          .optional()
          .describe(
            "Set to true to scan blackboard entries and decisions for staleness — flags items whose scope path, affected files, or originating branch no longer exist. Returns candidates only; use twining_archive_stale to act on them.",
          ),
        merge_sweep: z
          .boolean()
          .optional()
          .describe(
            "Set to true to detect branches deleted since the last housekeeping run (typically post-merge cleanup) and flag entries provenance-stamped with those branches. First call records the initial branch snapshot and returns no candidates. Returns candidates only; use twining_archive_stale to act on them.",
          ),
        stale_days: z
          .number()
          .optional()
          .describe("Flag provisional decisions older than this many days (default: 7)"),
        metrics_retention_days: z
          .number()
          .optional()
          .describe("Remove metrics older than this many days (default: 30)"),
      },
    },
    async (args) => {
      try {
        const result = await housekeepingEngine.run({
          execute: args.execute,
          promote_provisionals: args.promote_provisionals,
          staleness_review: args.staleness_review,
          merge_sweep: args.merge_sweep,
          stale_days: args.stale_days,
          metrics_retention_days: args.metrics_retention_days,
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

  server.registerTool(
    "twining_archive_stale",
    {
      description:
        "Archive a list of stale items by ID — typically the candidate IDs returned by twining_housekeeping with staleness_review: true. Decisions move to status \"archived\" (excluded from assemble/why). Blackboard entries are dismissed. Items remain on disk with provenance preserved.",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .describe("IDs to archive (mix of decision and blackboard IDs)"),
        reason: z
          .string()
          .optional()
          .describe("Optional rationale for the archive — recorded as a finding for the audit trail"),
      },
    },
    async (args) => {
      try {
        const archivedDecisions: string[] = [];
        const archivedEntries: string[] = [];
        const notFound: string[] = [];

        // Pull the decision index once so we can decide kind without N round-trips.
        const decisionIndex = await decisionStore.getIndex();
        const decisionIds = new Set(decisionIndex.map((e) => e.id));

        const blackboardIds: string[] = [];
        for (const id of args.ids) {
          if (decisionIds.has(id)) {
            try {
              await decisionStore.updateStatus(id, "archived");
              archivedDecisions.push(id);
            } catch {
              notFound.push(id);
            }
          } else {
            blackboardIds.push(id);
          }
        }

        if (blackboardIds.length > 0) {
          const dismissed = await blackboardEngine.dismiss(blackboardIds);
          archivedEntries.push(...dismissed.dismissed);
          notFound.push(...dismissed.not_found);
        }

        if (archivedDecisions.length + archivedEntries.length > 0) {
          await blackboardEngine.post({
            entry_type: "finding",
            summary: `Archived ${archivedDecisions.length + archivedEntries.length} stale items via housekeeping`,
            detail: [
              args.reason ? `Reason: ${args.reason}` : null,
              archivedDecisions.length > 0 ? `Decisions: ${archivedDecisions.join(", ")}` : null,
              archivedEntries.length > 0 ? `Blackboard entries: ${archivedEntries.join(", ")}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            tags: ["housekeeping", "stale-archive"],
            scope: "project",
          });
        }

        return toolResult({
          archived_decisions: archivedDecisions,
          archived_entries: archivedEntries,
          not_found: notFound,
          total_archived: archivedDecisions.length + archivedEntries.length,
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
