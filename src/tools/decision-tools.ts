/**
 * MCP tool handlers for decision operations.
 * Registers twining_decide, twining_why, twining_commits, twining_trace, twining_reconsider, twining_override, twining_promote.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionEngine } from "../engine/decisions.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";
import { writeRecordSentinel } from "../utils/record-sentinel.js";

export function registerDecisionTools(
  server: McpServer,
  engine: DecisionEngine,
  twiningDir: string,
  options: { fullSurface?: boolean } = {},
): void {
  // twining_decide — Record a decision with full rationale (full surface only — use twining_record instead)
  if (options.fullSurface) server.registerTool(
    "twining_decide",
    {
      description:
        "Record an architectural or implementation choice with rationale and rejected alternatives. Other agents will see this in their assemble briefing.",
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
        status: z
          .enum(["active", "provisional"])
          .optional()
          .describe(
            'Initial lifecycle status (default: "active"). "provisional" records the decision as awaiting ratification — it sits in the triage open lane until confirmed (twining_promote) or vetoed (twining_override). Cannot be combined with supersedes — the target would be retired before ratification; create as active, or promote first and then supersede. WARNING: twining_housekeeping with promote_provisionals + execute bulk-promotes provisionals older than 7 days with NO per-item review; leave that flag off if provisional is serving as your ratification queue.',
          ),
        affected_files: z
          .array(z.string())
          .optional()
          .describe("File paths affected by this decision"),
        affected_symbols: z
          .array(z.string())
          .optional()
          .describe("Function/class names affected"),
        assumptions: z
          .array(z.string())
          .optional()
          .describe("Assumptions this decision depends on — if any change, decision should be reconsidered"),
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
        writeRecordSentinel(twiningDir);
        const response: Record<string, unknown> = { ...result };
        if (result.dropped_depends_on && result.dropped_depends_on.length > 0) {
          response.message = `ignored ${result.dropped_depends_on.length} unknown depends_on id(s): ${result.dropped_depends_on.join(", ")}`;
        }
        return toolResult(response);
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

  // twining_why — Retrieve decision chain for a scope or file (#41: bounded)
  server.registerTool(
    "twining_why",
    {
      description:
        "Before modifying a file, check what decisions constrain it. Shows rationale and alternatives so you don't contradict prior choices. Results are ranked by relevance and bounded by a token budget; overflow decisions appear as one-liners in `more` — pass their ids back via `ids` for full detail.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe(
            "File path, module name, or symbol to query (required unless ids is set)",
          ),
        max_tokens: z
          .number()
          .optional()
          .describe(
            "Token budget for the full-detail tier (default 4000)",
          ),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Include superseded decisions (excluded by default)"),
        ids: z
          .array(z.string())
          .optional()
          .describe(
            "Return full detail (rationale, context, alternatives) for exactly these decision ids",
          ),
      },
    },
    async (args) => {
      try {
        if (!args.scope && (!args.ids || args.ids.length === 0)) {
          return toolError(
            "Provide a scope or a list of decision ids",
            "INVALID_INPUT",
          );
        }
        const result = await engine.why(args.scope ?? "", {
          max_tokens: args.max_tokens,
          include_superseded: args.include_superseded,
          ids: args.ids,
        });
        const response: Record<string, unknown> = { ...result };
        if (result.truncated) {
          response.message = `${result.more?.length ?? 0} more decision(s) in scope returned as one-liners in 'more' — call twining_why with ids: [...] for full detail on the ones that matter`;
        }
        return toolResult(response);
      } catch (e) {
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_trace — Trace a decision's dependency chain (full surface only)
  if (options.fullSurface) server.registerTool(
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

  // twining_reconsider — Flag a decision for reconsideration (full surface only)
  if (options.fullSurface) server.registerTool(
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

  // twining_override — Override a decision with a reason (full surface only)
  if (options.fullSurface) server.registerTool(
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

  // twining_promote — Promote provisional decisions to active (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_promote",
    {
      description:
        "Promote one or more provisional decisions to active status. Use this to confirm provisional decisions that have been validated through implementation and testing.",
      inputSchema: {
        decision_ids: z
          .array(z.string())
          .min(1)
          .describe("IDs of provisional decisions to promote to active"),
        promoted_by: z
          .string()
          .optional()
          .describe('Who is promoting (default: "main")'),
      },
    },
    async (args) => {
      try {
        const result = await engine.promote(
          args.decision_ids,
          args.promoted_by,
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

  // twining_commits — Query decisions by commit hash (full surface only)
  if (options.fullSurface) server.registerTool(
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

  // twining_search_decisions — Search decisions across all scopes (full surface only)
  if (options.fullSurface) server.registerTool(
    "twining_search_decisions",
    {
      description:
        "Search for decisions across all scopes by keyword or topic. Use when you need to find a specific past decision without knowing its exact scope.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Search query — keywords or natural language description of what you're looking for",
          ),
        domain: z
          .string()
          .optional()
          .describe(
            "Filter by decision domain (e.g., 'architecture', 'implementation')",
          ),
        status: z
          .enum(["active", "provisional", "superseded", "overridden", "archived"])
          .optional()
          .describe("Filter by decision status"),
        confidence: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Filter by confidence level"),
        limit: z
          .number()
          .optional()
          .describe("Maximum results to return (default: 20)"),
      },
    },
    async (args) => {
      try {
        const filters: {
          domain?: string;
          status?: "active" | "provisional" | "superseded" | "overridden" | "archived";
          confidence?: "high" | "medium" | "low";
        } = {};
        if (args.domain) filters.domain = args.domain;
        if (args.status) filters.status = args.status;
        if (args.confidence) filters.confidence = args.confidence;

        const result = await engine.searchDecisions(
          args.query,
          Object.keys(filters).length > 0 ? filters : undefined,
          args.limit,
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

  // twining_link_commit — Link a git commit hash to an existing decision (full surface only — use commit_hash param on twining_record instead)
  if (options.fullSurface) server.registerTool(
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
