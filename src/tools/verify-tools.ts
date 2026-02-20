/**
 * MCP tool handler for the twining_verify verification tool.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VerifyEngine } from "../engine/verify.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerVerifyTools(
  server: McpServer,
  verifyEngine: VerifyEngine,
): void {
  server.registerTool(
    "twining_verify",
    {
      description:
        "Run verification checks on a scope. Checks test coverage (tested_by relations), warnings acknowledgment, assembly-before-decision tracking, drift detection (P2 stub), and constraints (P2 stub). Auto-posts a finding with the summary.",
      inputSchema: {
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
    },
    async (args) => {
      try {
        const result = await verifyEngine.verify({
          scope: args.scope,
          checks: args.checks,
          agent_id: args.agent_id,
          fail_on: args.fail_on,
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
}
