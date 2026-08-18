/**
 * MCP tool handlers for blackboard operations.
 * Registers twining_post, twining_read, and twining_recent.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BlackboardEngine } from "../engine/blackboard.js";
import type { DecisionEngine } from "../engine/decisions.js";
import type { IDecisionStore } from "../storage/interfaces.js";
import { ENTRY_TYPES } from "../utils/types.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";
import { dedupeEntryFullSummary } from "../utils/full-summary.js";
import { writeRecordSentinel } from "../utils/record-sentinel.js";
import { appendDismissalTombstones } from "../engine/tombstones.js";

/** Whether an entry_types filter admits decision-store results. */
function includesDecisions(entryTypes?: string[]): boolean {
  return !entryTypes || entryTypes.includes("decision");
}

export function registerBlackboardTools(
  server: McpServer,
  engine: BlackboardEngine,
  twiningDir: string,
  options: {
    fullSurface?: boolean;
    // Decisions live only in the decision store (issue #30) — query/recent
    // merge decision-store results into their output when these are provided.
    decisionEngine?: DecisionEngine;
    decisionStore?: IDecisionStore;
  } = {},
): void {
  // twining_post — Post an entry to the shared blackboard
  server.registerTool(
    "twining_post",
    {
      description:
        "Share a finding, warning, need, or status update with other agents. Post a 'status' entry before ending each session. Does NOT accept entry_type 'decision' — use twining_decide instead.",
      inputSchema: {
        entry_type: z.enum(ENTRY_TYPES).describe("Type of blackboard entry"),
        summary: z
          .string()
          .max(200)
          .describe(
            "One-line summary (max 200 chars). Lead with the most important " +
              "information — it carries the most weight in similarity search.",
          ),
        detail: z.string().optional().describe("Full context and details"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Domain tags for filtering"),
        scope: z
          .string()
          .optional()
          .describe('File path, module name, or "project"'),
        relates_to: z
          .array(z.string())
          .optional()
          .describe(
            "IDs of related entries. Back-referencing an open need/question/" +
              "warning marks it resolved out of the open triage lane (e.g. an " +
              "answer posted with relates_to: [question_id]). For an explicit, " +
              "durable resolution prefer twining_resolve.",
          ),
        agent_id: z
          .string()
          .optional()
          .describe("Identifier for the posting agent"),
      },
    },
    async (args) => {
      try {
        const result = await engine.post(args);
        writeRecordSentinel(twiningDir);
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

  // twining_read — Read blackboard entries with optional filters (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_read",
    {
      description:
        "Read blackboard entries with optional filters. Use this to check what other agents have posted, find relevant context, or review recent activity.",
      inputSchema: {
        entry_types: z
          .array(z.string())
          .optional()
          .describe("Filter by entry type(s)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Filter by tags (OR match)"),
        scope: z
          .string()
          .optional()
          .describe("Filter by scope (prefix match)"),
        since: z
          .string()
          .refine((val) => !isNaN(Date.parse(val)), {
            message: "Must be a valid ISO 8601 timestamp",
          })
          .optional()
          .describe("Only entries after this ISO 8601 timestamp"),
        limit: z
          .number()
          .optional()
          .describe("Max entries to return (default: 50)"),
      },
    },
    async (args) => {
      try {
        const result = await engine.read(args);
        // S4-1 read half: collapse the lossless "Full summary:" duplication
        // in the response; on-disk entries are untouched.
        return toolResult({
          ...result,
          entries: result.entries.map(dedupeEntryFullSummary),
        });
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_query — Semantic search across blackboard entries (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_query",
    {
      description:
        "Semantic search across blackboard entries and recorded decisions. Uses embeddings when available, falls back to keyword search. Returns blackboard entries in `results` and decision-store matches in `decisions`, each ranked by relevance.",
      inputSchema: {
        query: z.string().describe("Natural language query"),
        entry_types: z
          .array(z.string())
          .optional()
          .describe(
            'Optional type filter. Include "decision" (or omit the filter) to also search recorded decisions.',
          ),
        limit: z
          .number()
          .optional()
          .describe("Max results (default: 10)"),
      },
    },
    async (args) => {
      try {
        const result = await engine.query(args.query, {
          entry_types: args.entry_types,
          limit: args.limit,
        });

        // Merge decision-store matches (issue #30): decisions are no longer
        // mirrored on the blackboard, so search them directly.
        let decisions: Array<Record<string, unknown>> = [];
        if (options.decisionEngine && includesDecisions(args.entry_types)) {
          const decisionSearch = await options.decisionEngine.searchDecisions(
            args.query,
            undefined,
            args.limit ?? 10,
          );
          decisions = decisionSearch.results.map((d) => ({
            type: "decision" as const,
            ...d,
          }));
        }

        return toolResult({
          ...result,
          results: result.results.map((r) => ({
            ...r,
            entry: dedupeEntryFullSummary(r.entry),
          })),
          decisions,
        });
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_recent — Quick access to latest entries (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_recent",
    {
      description:
        "Get the most recent blackboard entries and recorded decisions. Quick way to see latest activity without specifying filters. Blackboard entries are returned in `entries`, decision-store records in `decisions`.",
      inputSchema: {
        n: z
          .number()
          .optional()
          .describe("Number of entries to return (default: 20)"),
        entry_types: z
          .array(z.string())
          .optional()
          .describe(
            'Optional type filter. Include "decision" (or omit the filter) to also get recent recorded decisions.',
          ),
      },
    },
    async (args) => {
      try {
        const result = await engine.recent(args.n, args.entry_types);

        // Merge recent decision-store records (issue #30): decisions are no
        // longer mirrored on the blackboard, so read the store directly.
        let decisions: Array<Record<string, unknown>> = [];
        if (options.decisionStore && includesDecisions(args.entry_types)) {
          const index = await options.decisionStore.getIndex();
          decisions = index
            .slice()
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, args.n ?? 20)
            .map((d) => ({
              type: "decision" as const,
              id: d.id,
              timestamp: d.timestamp,
              summary: d.summary,
              domain: d.domain,
              scope: d.scope,
              status: d.status,
              confidence: d.confidence,
            }));
        }

        return toolResult({
          ...result,
          entries: result.entries.map(dedupeEntryFullSummary),
          decisions,
        });
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_resolve — Mark open items handled while preserving the record.
  // DEFAULT surface deliberately (unlike twining_dismiss): the field defect
  // behind this tool (D2) was that the everyday surface offered no exit from
  // the open lane at all, so agents let it grow rather than delete history.
  server.registerTool(
    "twining_resolve",
    {
      description:
        "Mark open blackboard items (needs, questions, warnings) as handled. Persists status \"resolved\" with resolver identity and an optional note; the entry leaves the open triage/assemble lane but stays on the board as searchable history. This is the everyday exit for open items — use twining_dismiss only for noise that should never have been recorded.",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .describe("Entry IDs to mark resolved"),
        note: z
          .string()
          .optional()
          .describe("How the item was handled — stored as resolution_note"),
        agent_id: z
          .string()
          .optional()
          .describe("Identifier for the resolving agent"),
      },
    },
    async (args) => {
      try {
        const result = await engine.resolve(args.ids, {
          agent_id: args.agent_id,
          note: args.note,
        });
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

  // twining_dismiss — Remove specific blackboard entries by ID (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_dismiss",
    {
      description:
        "Remove blackboard entries by ID — for noise only: false positives, duplicates, test debris. Dismissal DELETES the live entry everywhere (including the committed record on export-backed stores); a tombstone with your reason is appended to .twining/archive/, which is gitignored — the tombstone audit trail is LOCAL to this machine. For substantive items that were handled, use twining_resolve instead — it preserves the record while closing the open lane.",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .describe("Entry IDs to remove from the blackboard"),
        reason: z
          .string()
          .optional()
          .describe("Why these entries are being dismissed — stored on the archive tombstone"),
        agent_id: z
          .string()
          .optional()
          .describe("Identifier for the dismissing agent — stored on the tombstone"),
      },
    },
    async (args) => {
      try {
        // Capture doomed entries BEFORE the delete so the tombstone can
        // carry the full record. limit: 0 disables the read cap.
        const { entries } = await engine.read({ limit: 0 });
        const idSet = new Set(args.ids);
        const doomed = entries.filter((e) => idSet.has(e.id));

        const result = await engine.dismiss(args.ids);

        const dismissedSet = new Set(result.dismissed);
        appendDismissalTombstones(
          twiningDir,
          doomed.filter((e) => dismissedSet.has(e.id)),
          { reason: args.reason, dismissed_by: args.agent_id },
        );
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
