/**
 * MCP tool handlers for decision operations.
 * Registers twining_decide, twining_why, twining_commits, twining_trace, twining_reconsider, twining_override.
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
        commit_hash: z
          .string()
          .optional()
          .describe("Git commit hash to associate with this decision"),
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

  // twining_trace — Trace a decision's dependency chain
  server.registerTool(
    "twining_trace",
    {
      description:
        "Trace a decision's dependency chain upstream (what it depends on) and/or downstream (what depends on it). Uses BFS with cycle protection.",
      inputSchema: {
        decision_id: z.string().describe("ID of the decision to trace"),
        direction: z
          .enum(["upstream", "downstream", "both"])
          .optional()
          .describe('Direction to trace (default: "both")'),
      },
    },
    async (args) => {
      try {
        const result = await engine.trace(args.decision_id, args.direction);
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

  // twining_reconsider — Flag a decision for reconsideration
  server.registerTool(
    "twining_reconsider",
    {
      description:
        "Flag a decision for reconsideration. Sets active decisions to provisional status and posts a warning to the blackboard with downstream impact analysis.",
      inputSchema: {
        decision_id: z.string().describe("ID of the decision to reconsider"),
        new_context: z
          .string()
          .describe("New context or reason for reconsideration"),
        agent_id: z
          .string()
          .optional()
          .describe("ID of the agent requesting reconsideration"),
      },
    },
    async (args) => {
      try {
        const result = await engine.reconsider(
          args.decision_id,
          args.new_context,
          args.agent_id,
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

  // twining_override — Override a decision with a reason
  server.registerTool(
    "twining_override",
    {
      description:
        "Override a decision with a reason. Sets the decision to overridden status, records who overrode it and why, and optionally creates a replacement decision automatically.",
      inputSchema: {
        decision_id: z.string().describe("ID of the decision to override"),
        reason: z.string().describe("Reason for the override"),
        new_decision: z
          .string()
          .optional()
          .describe("Summary of the replacement decision to auto-create"),
        overridden_by: z
          .string()
          .optional()
          .describe('Who is overriding (default: "human")'),
      },
    },
    async (args) => {
      try {
        const result = await engine.override(
          args.decision_id,
          args.reason,
          args.new_decision,
          args.overridden_by,
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

  // twining_commits — Query decisions by commit hash
  server.registerTool(
    "twining_commits",
    {
      description:
        "Query decisions by commit hash. Returns all decisions that were linked to a given commit, enabling traceability from code changes back to decision rationale.",
      inputSchema: {
        commit_hash: z
          .string()
          .describe("Git commit hash to look up"),
      },
    },
    async (args) => {
      try {
        const result = await engine.getByCommitHash(args.commit_hash);
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

  // twining_link_commit — Link a git commit hash to an existing decision
  server.registerTool(
    "twining_link_commit",
    {
      description:
        "Link a git commit hash to an existing decision. Enables bidirectional traceability between decisions and commits.",
      inputSchema: {
        decision_id: z.string().describe("ID of the decision to link"),
        commit_hash: z.string().describe("Git commit hash to link"),
        agent_id: z
          .string()
          .optional()
          .describe("ID of the agent performing the link"),
      },
    },
    async (args) => {
      try {
        const result = await engine.linkCommit(
          args.decision_id,
          args.commit_hash,
          args.agent_id,
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
