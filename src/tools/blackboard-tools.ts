/**
 * MCP tool handlers for blackboard operations.
 * Registers twining_post, twining_read, and twining_recent.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BlackboardEngine } from "../engine/blackboard.js";
import { ENTRY_TYPES } from "../utils/types.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerBlackboardTools(
  server: McpServer,
  engine: BlackboardEngine,
): void {
  // twining_post — Post an entry to the shared blackboard
  server.registerTool(
    "twining_post",
    {
      description:
        "Post an entry to the shared blackboard. Use this to share findings, needs, warnings, status updates, and other coordination messages with other agents. Does NOT accept entry_type 'decision' — use twining_decide instead.",
      inputSchema: {
        entry_type: z.enum(ENTRY_TYPES).describe("Type of blackboard entry"),
        summary: z
          .string()
          .max(200)
          .describe("One-line summary (max 200 chars)"),
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

  // twining_read — Read blackboard entries with optional filters
  server.registerTool(
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

  // twining_query — Semantic search across blackboard entries
  server.registerTool(
    "twining_query",
    {
      description:
        "Semantic search across blackboard entries. Uses embeddings when available, falls back to keyword search. Returns entries ranked by relevance.",
      inputSchema: {
        query: z.string().describe("Natural language query"),
        entry_types: z
          .array(z.string())
          .optional()
          .describe("Optional type filter"),
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
        return toolResult(result);
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_recent — Quick access to latest entries
  server.registerTool(
    "twining_recent",
    {
      description:
        "Get the most recent blackboard entries. Quick way to see latest activity without specifying filters.",
      inputSchema: {
        n: z
          .number()
          .optional()
          .describe("Number of entries to return (default: 20)"),
        entry_types: z
          .array(z.string())
          .optional()
          .describe("Optional type filter"),
      },
    },
    async (args) => {
      try {
        const result = await engine.recent(args.n, args.entry_types);
        return toolResult(result);
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_dismiss — Remove specific blackboard entries by ID
  server.registerTool(
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
