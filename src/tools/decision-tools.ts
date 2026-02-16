/**
 * MCP tool handlers for decision operations.
 * Registers twining_decide and twining_why.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionEngine } from "../engine/decisions.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerDecisionTools(
  server: McpServer,
  engine: DecisionEngine,
): void {
  // twining_decide — Record a decision with full rationale
  server.registerTool(
    "twining_decide",
    {
      description:
        "Record a decision with full rationale, alternatives considered, and traceability. Creates a decision record and cross-posts to the blackboard.",
      inputSchema: {
        domain: z
          .string()
          .describe(
            'Decision domain (e.g., "architecture", "implementation", "testing")',
          ),
        scope: z
          .string()
          .describe("What part of the codebase this affects"),
        summary: z.string().describe("One-line decision statement"),
        context: z.string().describe("Situation that prompted this decision"),
        rationale: z.string().describe("Reasoning for the choice"),
        constraints: z
          .array(z.string())
          .optional()
          .describe("What limited the options"),
        alternatives: z
          .array(
            z.object({
              option: z.string().describe("Alternative option considered"),
              pros: z
                .array(z.string())
                .optional()
                .describe("Advantages of this alternative"),
              cons: z
                .array(z.string())
                .optional()
                .describe("Disadvantages of this alternative"),
              reason_rejected: z
                .string()
                .describe("Why this alternative was rejected"),
            }),
          )
          .optional()
          .describe("Alternatives that were considered"),
        depends_on: z
          .array(z.string())
          .optional()
          .describe("IDs of prerequisite decisions"),
        supersedes: z
          .string()
          .optional()
          .describe("ID of decision this replaces"),
        confidence: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe('Confidence level (default: "medium")'),
        reversible: z
          .boolean()
          .optional()
          .describe("Whether this decision is easily reversible (default: true)"),
        affected_files: z
          .array(z.string())
          .optional()
          .describe("File paths affected by this decision"),
        affected_symbols: z
          .array(z.string())
          .optional()
          .describe("Function/class names affected"),
        agent_id: z
          .string()
          .optional()
          .describe('Identifier for the deciding agent (default: "main")'),
      },
    },
    async (args) => {
      try {
        const result = await engine.decide(args);
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

  // twining_why — Retrieve decision chain for a scope or file
  server.registerTool(
    "twining_why",
    {
      description:
        'Retrieve all decisions affecting a given scope or file. Shows the decision chain with rationale, confidence, and alternatives count. Essential for understanding "why was it done this way?"',
      inputSchema: {
        scope: z
          .string()
          .describe("File path, module name, or symbol to query"),
      },
    },
    async (args) => {
      try {
        const result = await engine.why(args.scope);
        return toolResult(result);
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );
}
