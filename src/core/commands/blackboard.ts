/**
 * Blackboard commands: twining_post, twining_read, twining_query,
 * twining_recent, twining_resolve, twining_dismiss.
 * Extracted verbatim from src/tools/blackboard-tools.ts (2.17.0).
 */
import { z } from "zod";
import type { BlackboardEngine } from "../../engine/blackboard.js";
import type { DecisionEngine } from "../../engine/decisions.js";
import type { IDecisionStore } from "../../storage/interfaces.js";
import { ENTRY_TYPES } from "../../utils/types.js";
import { dedupeEntryFullSummary } from "../../utils/full-summary.js";
import { writeRecordSentinel } from "../../utils/record-sentinel.js";
import { appendDismissalTombstones } from "../../engine/tombstones.js";
import { commandFactory, type CommandDef } from "../command-def.js";

export interface BlackboardCtx {
  blackboardEngine: BlackboardEngine;
  twiningDir: string;
  // Decisions live only in the decision store (issue #30) — query/recent
  // merge decision-store results into their output when these are provided.
  decisionEngine?: DecisionEngine;
  decisionStore?: IDecisionStore;
}

const { define } = commandFactory<BlackboardCtx>();

/** Whether an entry_types filter admits decision-store results. */
function includesDecisions(entryTypes?: string[]): boolean {
  return !entryTypes || entryTypes.includes("decision");
}

export const blackboardCommands: CommandDef<BlackboardCtx>[] = [
  define({
    name: "twining_post",
    surface: "default",
    description:
      "Share a finding, warning, need, or status update with other agents. Post a 'status' entry before ending each session. Does NOT accept entry_type 'decision' — use twining_decide instead.",
    input: {
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
    async handler(ctx, args) {
      const result = await ctx.blackboardEngine.post(args);
      writeRecordSentinel(ctx.twiningDir);
      return result;
    },
  }),

  define({
    name: "twining_read",
    surface: "full",
    errors: "internal-only",
    description:
      "Read blackboard entries with optional filters. Use this to check what other agents have posted, find relevant context, or review recent activity.",
    input: {
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
    async handler(ctx, args) {
      const result = await ctx.blackboardEngine.read(args);
      // S4-1 read half: collapse the lossless "Full summary:" duplication
      // in the response; on-disk entries are untouched.
      return {
        ...result,
        entries: result.entries.map(dedupeEntryFullSummary),
      };
    },
  }),

  define({
    name: "twining_query",
    surface: "full",
    errors: "internal-only",
    description:
      "Semantic search across blackboard entries and recorded decisions. Uses embeddings when available, falls back to keyword search. Returns blackboard entries in `results` and decision-store matches in `decisions`, each ranked by relevance.",
    input: {
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
    async handler(ctx, args) {
      const result = await ctx.blackboardEngine.query(args.query, {
        entry_types: args.entry_types,
        limit: args.limit,
      });

      // Merge decision-store matches (issue #30): decisions are no longer
      // mirrored on the blackboard, so search them directly.
      let decisions: Array<Record<string, unknown>> = [];
      if (ctx.decisionEngine && includesDecisions(args.entry_types)) {
        const decisionSearch = await ctx.decisionEngine.searchDecisions(
          args.query,
          undefined,
          args.limit ?? 10,
        );
        decisions = decisionSearch.results.map((d) => ({
          type: "decision" as const,
          ...d,
        }));
      }

      return {
        ...result,
        results: result.results.map((r) => ({
          ...r,
          entry: dedupeEntryFullSummary(r.entry),
        })),
        decisions,
      };
    },
  }),

  define({
    name: "twining_recent",
    surface: "full",
    errors: "internal-only",
    description:
      "Get the most recent blackboard entries and recorded decisions. Quick way to see latest activity without specifying filters. Blackboard entries are returned in `entries`, decision-store records in `decisions`.",
    input: {
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
    async handler(ctx, args) {
      const result = await ctx.blackboardEngine.recent(args.n, args.entry_types);

      // Merge recent decision-store records (issue #30): decisions are no
      // longer mirrored on the blackboard, so read the store directly.
      let decisions: Array<Record<string, unknown>> = [];
      if (ctx.decisionStore && includesDecisions(args.entry_types)) {
        const index = await ctx.decisionStore.getIndex();
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

      return {
        ...result,
        entries: result.entries.map(dedupeEntryFullSummary),
        decisions,
      };
    },
  }),

  // twining_resolve — Mark open items handled while preserving the record.
  // DEFAULT surface deliberately (unlike twining_dismiss): the field defect
  // behind this tool (D2) was that the everyday surface offered no exit from
  // the open lane at all, so agents let it grow rather than delete history.
  define({
    name: "twining_resolve",
    surface: "default",
    description:
      "Mark open blackboard items (needs, questions, warnings) as handled. Persists status \"resolved\" with resolver identity and an optional note; the entry leaves the open triage/assemble lane but stays on the board as searchable history. This is the everyday exit for open items — use twining_dismiss only for noise that should never have been recorded.",
    input: {
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
    async handler(ctx, args) {
      return await ctx.blackboardEngine.resolve(args.ids, {
        agent_id: args.agent_id,
        note: args.note,
      });
    },
  }),

  define({
    name: "twining_dismiss",
    surface: "full",
    description:
      "Remove blackboard entries by ID — for noise only: false positives, duplicates, test debris. Dismissal DELETES the live entry everywhere (including the committed record on export-backed stores); a tombstone with your reason is appended to .twining/archive/, which is gitignored — the tombstone audit trail is LOCAL to this machine. For substantive items that were handled, use twining_resolve instead — it preserves the record while closing the open lane.",
    input: {
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
    async handler(ctx, args) {
      // Capture doomed entries BEFORE the delete so the tombstone can
      // carry the full record. limit: 0 disables the read cap.
      const { entries } = await ctx.blackboardEngine.read({ limit: 0 });
      const idSet = new Set(args.ids);
      const doomed = entries.filter((e) => idSet.has(e.id));

      const result = await ctx.blackboardEngine.dismiss(args.ids);

      const dismissedSet = new Set(result.dismissed);
      appendDismissalTombstones(
        ctx.twiningDir,
        doomed.filter((e) => dismissedSet.has(e.id)),
        { reason: args.reason, dismissed_by: args.agent_id },
      );
      return result;
    },
  }),
];
