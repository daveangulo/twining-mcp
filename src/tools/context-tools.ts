/**
 * MCP tool handlers for context assembly operations.
 * Registers twining_assemble, twining_summarize, and twining_what_changed.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContextAssembler } from "../engine/context-assembler.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerContextTools(
  server: McpServer,
  contextAssembler: ContextAssembler,
  options: { fullSurface?: boolean } = {},
): void {
  // twining_assemble — Build tailored context for a specific task
  server.registerTool(
    "twining_assemble",
    {
      description:
        "Your FIRST call every session. Returns a briefing with decisions to respect, warnings to address, and handoff context from previous agents. Call BEFORE reading code or making changes.",
      inputSchema: {
        task: z.string().describe("Description of what the agent is about to do"),
        scope: z
          .string()
          .describe('File path, module, or area of codebase (e.g., "src/auth/" or "project")'),
        max_tokens: z
          .number()
          .optional()
          .describe("Token budget (default: from config, typically 4000)"),
        agent_id: z
          .string()
          .optional()
          .describe("Agent identifier for assembly tracking (default: main)"),
      },
    },
    async (args) => {
      try {
        const { context, status_summary } = await contextAssembler.assembleWithStatus(
          args.task,
          args.scope,
          args.max_tokens,
          args.agent_id,
        );
        const formatted = ContextAssembler.formatForLLM(context, status_summary);
        // Return only the briefing + metadata — avoids duplicating structured data
        // that wastes agent context tokens. Use twining_why for detailed lookups.
        return toolResult({
          briefing: formatted,
          scope: context.scope,
          decisions_count: context.active_decisions.length,
          warnings_count: context.active_warnings.length,
          needs_count: context.open_needs.length,
          // D3: distinguishes "decisions were archived away" from "none exist"
          ...(context.archived_excluded_count
            ? { archived_excluded_count: context.archived_excluded_count }
            : {}),
          token_estimate: context.token_estimate,
        });
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

  // twining_summarize — High-level summary of project or scope state (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_summarize",
    {
      description:
        "Get a high-level summary of project or scope state. Returns counts of active decisions, open needs, warnings, and a recent activity narrative.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe('Optional scope filter (default: "project")'),
      },
    },
    async (args) => {
      try {
        const result = await contextAssembler.summarize(args.scope);
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

  // twining_what_changed — Report changes since a given point in time (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_what_changed",
    {
      description:
        "Report what changed since a given point in time. Returns new decisions, new entries, overridden decisions, and reconsidered decisions. Use this to catch up on changes since you last checked.",
      inputSchema: {
        since: z
          .string()
          .refine((val) => !isNaN(Date.parse(val)), {
            message: "Must be a valid ISO 8601 timestamp",
          })
          .describe("ISO 8601 timestamp (e.g., 2024-01-15T10:00:00Z)"),
        scope: z.string().optional().describe("Optional scope filter"),
      },
    },
    async (args) => {
      try {
        const result = await contextAssembler.whatChanged(
          args.since,
          args.scope,
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
