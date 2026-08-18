/**
 * MCP tool handlers for lifecycle operations.
 * Registers twining_status (enhanced with graph counts and warnings) and twining_archive.
 */
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Archiver } from "../engine/archiver.js";
import { NO_AGE_CUTOFF, partitionArchivable } from "../engine/archiver.js";
import { computeResolvedIds } from "../engine/resolution.js";
import type { TwiningConfig } from "../utils/types.js";
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
} from "../utils/liveness.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";
import type { IAgentStore, IBlackboardStore, IDecisionStore, IGraphStore } from "../storage/interfaces.js";

/** Build/backend identity threaded from createServer so a session can learn
 * which server build and storage backend serve it from the response itself
 * (2026-08-15 field audit: two builds served concurrent sessions on one
 * machine and nothing in any response could tell them apart). */
export interface ServerIdentity {
  serverVersion?: string;
  backend?: "files" | "sqlite";
  backendReason?: string;
  legacyUnread?: boolean;
  recordsUnread?: boolean;
}

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
  // twining_status — Overall health check of the Twining state
  server.registerTool(
    "twining_status",
    {
      description:
        "Overall health check of the Twining state. Shows blackboard entry count, decision counts, graph entity/relation counts, actionable warnings, the server_version and resolved storage backend, and a human-readable summary. provisional_decisions is the canonical ratify-queue count — a direct index count no query can distort (scoped variant: twining_triage counts.open.by_kind.decision). Note: twining_assemble now includes a status summary — use this only when you need the full detailed health check.",
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

        // Archiving threshold — computed from THE archive partition, not the
        // raw entry count (review finding): exempt classes (decisions, open
        // obligations) and the D4 retention floor never archive, so a raw
        // count reads "archive recommended" permanently on a busy board and
        // steers agents into pointless (or retention-bypassing) sweeps.
        const archiveThreshold =
          config.archive.max_blackboard_entries_before_archive;
        const { entries: allBoardEntries } = await blackboardStore.read();
        const archivableCount = partitionArchivable(
          allBoardEntries,
          computeResolvedIds(allBoardEntries),
          {
            before: NO_AGE_CUTOFF,
            retain: config.archive.retain_recent ?? 0,
          },
        ).to_archive.length;
        const needs_archiving = archivableCount >= archiveThreshold;

        // Actionable warnings
        const warnings: string[] = [];

        // Silent-amnesia surface (S0): the one warning that must never be
        // quiet. First in the list — every other warning is secondary to
        // "your store is not reading its own state".
        if (identity.legacyUnread) {
          warnings.push(
            "Legacy v1 content (decisions/, blackboard.jsonl, or graph/) is present but UNREAD by the sqlite backend — this store reads as (partially) empty. Run `npx twining-mcp migrate` to import it (see docs/UPGRADE-v2.md).",
          );
        }
        // Reverse stranding (review SC-4): sqlite→files fallback serving
        // stale legacy history while the migrated truth sits in records/.
        if (identity.recordsUnread) {
          warnings.push(
            "The server FELL BACK to the files backend but migrated state exists in .twining/records/ — this session may be reading stale legacy history. Fix the sqlite prerequisite (Node >= 22.13, openable twining.db) and restart.",
          );
        }

        // Files-backend index desync (S0-index-desync): decision files on
        // disk that the index — and therefore every read path — cannot see.
        if (identity.backend !== "sqlite") {
          const ds = decisionStore as Partial<{
            repairIndexDesync: (
              execute: boolean,
            ) => Promise<{ orphan_ids: string[]; repaired: number }>;
          }>;
          if (typeof ds.repairIndexDesync === "function") {
            try {
              const desync = await ds.repairIndexDesync(false);
              if (desync.orphan_ids.length > 0) {
                warnings.push(
                  `${desync.orphan_ids.length} decision file(s) on disk are missing from decisions/index.json (index desync) — they are invisible to every read path. Run twining_housekeeping({repair_index: true, execute: true}) or npx twining-mcp migrate.`,
                );
              }
            } catch {
              // Detection is advisory — never fail status over it.
            }
          }
        }

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
            `Blackboard has ${archivableCount} archivable entries (${blackboard_entries} total), archive recommended (threshold: ${archiveThreshold}) — twining_housekeeping({archive: true, execute: true})`,
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
          ...(identity.serverVersion
            ? { server_version: identity.serverVersion }
            : {}),
          ...(identity.backend ? { backend: identity.backend } : {}),
          ...(identity.backendReason
            ? { backend_reason: identity.backendReason }
            : {}),
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
        "Archive old blackboard entries. Moves entries older than a cutoff timestamp to an archive file, preserving decision entries and unresolved need/warning/question entries (#40 — an item counts as resolved when explicitly resolved via twining_resolve or when a later entry references it via relates_to). Optionally posts a summary finding. WARNING: the cutoff defaults to now, so an argument-free call archives everything archivable — pass `before` or `retain` unless a full sweep is intended.",
      inputSchema: {
        before: z
          .string()
          .refine((val) => !isNaN(Date.parse(val)), {
            message: "Must be a valid ISO 8601 timestamp",
          })
          .optional()
          .describe("ISO timestamp cutoff — archive entries before this time (default: now)"),
        retain: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Keep the newest N archivable entries on the board regardless of age (D4 count-based retention — an age cutoff cannot bound a same-hour burst). Default 0 = no retention.",
          ),
        keep_decisions: z
          .boolean()
          .optional()
          .describe("Whether to keep decision entries in the blackboard (default: true)"),
        keep_open_needs_warnings: z
          .boolean()
          .optional()
          .describe(
            "Whether to exempt unresolved need/warning entries from age-based archiving (default: true). Set false to force a full sweep.",
          ),
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
