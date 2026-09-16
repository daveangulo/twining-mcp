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
      "Your FIRST call every session. Returns a briefing with decisions to respect, warnings to address, and handoff context from previous agents. Call BEFORE reading code or making changes. Truncation is now reported explicitly, not inferred from a number: retrieval.token_usage.over_budget and retrieval.token_usage.omitted_decisions say whether anything was clipped — re-call with a larger max_tokens (e.g. 100000) when they are set. token_estimate is a deliberately conservative upper bound on the emitted briefing and is NOT comparable to max_tokens. decisions_count is the briefing selection, not a scope census; use twining_why total_in_scope for populations.",
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
        // `mode: "lessons"` is deliberately NOT exposed here.
        //
        // The channel is entitlement-gated, and 2.x has no principals and no
        // membership policy, so there is no source that could grant the
        // entitlement — every lessons request would be denied. Shipping a
        // parameter whose only possible outcome is denial invites callers to
        // read that denial as "no lessons exist". The engine supports the mode
        // and it is tested; it becomes callable when a real entitlement source
        // lands (lane 02's membership projection).
        undefined,
      );
      const formatted = ContextAssembler.formatForLLM(context, status_summary);
      // Return only the briefing + metadata — avoids duplicating structured data
      // that wastes agent context tokens. Use twining_why for detailed lookups.
      const body = {
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
        // --- Lane 04 additive fields. Existing consumers are unaffected. ---
        retrieval: context.retrieval,
      };
      // Measure the payload that actually goes on the wire — the serialized
      // envelope, not just the briefing — and hash the emitted briefing
      // (R16/R17). Done after `body` exists so the annex's own bytes are
      // inside the measurement.
      ContextAssembler.annotateEmitted(context, formatted, JSON.stringify(body));
      body.token_estimate = context.token_estimate;
      body.retrieval = context.retrieval;
      return body;
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
