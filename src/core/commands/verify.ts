/**
 * Verification command: twining_verify.
 * Extracted verbatim from src/tools/verify-tools.ts.
 */
import { z } from "zod";
import type { VerifyEngine } from "../../engine/verify.js";
import { commandFactory, type CommandDef } from "../command-def.js";

export interface VerifyCtx {
  verifyEngine: VerifyEngine;
}

const { define } = commandFactory<VerifyCtx>();

export const verifyCommands: CommandDef<VerifyCtx>[] = [
  define({
    name: "twining_verify",
    surface: "full",
    description:
      "Check decision hygiene on a scope: unresolved warnings, assembly-before-decision tracking, and drift detection. Recommended for complex tasks before handoff.",
    input: {
      scope: z.string().describe("Scope to verify (e.g., \"src/auth/\" or \"project\")"),
      checks: z
        .array(
          z.enum([
            "test_coverage",
            "warnings",
            "drift",
            "assembly",
            "constraints",
          ]),
        )
        .optional()
        .describe(
          "Specific checks to run (default: all). Options: test_coverage, warnings, drift, assembly, constraints",
        ),
      agent_id: z
        .string()
        .optional()
        .describe(
          "Filter assembly check to a specific agent (default: all agents)",
        ),
      fail_on: z
        .array(z.string())
        .optional()
        .describe(
          "Check names that should cause a failure status if they don't pass",
        ),
    },
    async handler(ctx, args) {
      return await ctx.verifyEngine.verify({
        scope: args.scope,
        checks: args.checks,
        agent_id: args.agent_id,
        fail_on: args.fail_on,
      });
    },
  }),
];
