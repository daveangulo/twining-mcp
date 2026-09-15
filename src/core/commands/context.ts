/**
 * Context-assembly commands: twining_assemble, twining_summarize,
 * twining_what_changed. Extracted verbatim from src/tools/context-tools.ts.
 */
import { z } from "zod";
import { ContextAssembler } from "../../engine/context-assembler.js";
import { commandFactory, type CommandDef } from "../command-def.js";

export interface ContextCtx {
  contextAssembler: ContextAssembler;
}

const { define } = commandFactory<ContextCtx>();

export const contextCommands: CommandDef<ContextCtx>[] = [
  define({
    name: "twining_assemble",
    surface: "default",
    description:
      "Your FIRST call every session. Returns a briefing with decisions to respect, warnings to address, and handoff context from previous agents. Call BEFORE reading code or making changes. token_estimate ≈ max_tokens is the signature of budget truncation: the briefing (and decisions_count) was clipped — re-call with a larger max_tokens (e.g. 100000) for complete coverage. decisions_count is the briefing selection, not a scope census; use twining_why total_in_scope for populations.",
    input: {
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
    async handler(ctx, args) {
      const { context, status_summary } = await ctx.contextAssembler.assembleWithStatus(
        args.task,
        args.scope,
        args.max_tokens,
        args.agent_id,
      );
      const formatted = ContextAssembler.formatForLLM(context, status_summary);
      // Return only the briefing + metadata — avoids duplicating structured data
      // that wastes agent context tokens. Use twining_why for detailed lookups.
      return {
        briefing: formatted,
        scope: context.scope,
        decisions_count: context.active_decisions.length,
        warnings_count: context.active_warnings.length,
        needs_count: context.open_needs.length,
        // D3: distinguishes "decisions were archived away" from "none exist"
        ...(context.archived_excluded_count
          ? { archived_excluded_count: context.archived_excluded_count }
          : {}),
        ...(context.superseded_excluded_count
          ? { superseded_excluded_count: context.superseded_excluded_count }
          : {}),
        token_estimate: context.token_estimate,
      };
    },
  }),

  define({
    name: "twining_summarize",
    surface: "full",
    description:
      "Get a high-level summary of project or scope state. Returns counts of active decisions, open needs, warnings, and a recent activity narrative.",
    input: {
      scope: z
        .string()
        .optional()
        .describe('Optional scope filter (default: "project")'),
    },
    async handler(ctx, args) {
      return await ctx.contextAssembler.summarize(args.scope);
    },
  }),

  define({
    name: "twining_what_changed",
    surface: "full",
    description:
      "Report what changed since a given point in time. Returns new decisions, new entries, overridden decisions, and reconsidered decisions. Use this to catch up on changes since you last checked.",
    input: {
      since: z
        .string()
        .refine((val) => !isNaN(Date.parse(val)), {
          message: "Must be a valid ISO 8601 timestamp",
        })
        .describe("ISO 8601 timestamp (e.g., 2024-01-15T10:00:00Z)"),
      scope: z.string().optional().describe("Optional scope filter"),
    },
    async handler(ctx, args) {
      return await ctx.contextAssembler.whatChanged(args.since, args.scope);
    },
  }),
];
