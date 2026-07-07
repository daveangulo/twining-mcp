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
import { writeRecordSentinel } from "../utils/record-sentinel.js";

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
          .describe("IDs of related entries"),
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
        return toolResult(result);
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

        return toolResult({ ...result, decisions });
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

        return toolResult({ ...result, decisions });
      } catch (e) {
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
        "Remove specific blackboard entries by ID. Use this to clean up false-positive warnings, resolved entries, or other noise. Returns which IDs were dismissed and which were not found.",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .describe("Entry IDs to remove from the blackboard"),
        reason: z
          .string()
          .optional()
          .describe("Why these entries are being dismissed (logged but not stored)"),
      },
    },
    async (args) => {
      try {
        const result = await engine.dismiss(args.ids);
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
