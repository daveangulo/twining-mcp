/**
 * MCP tool handler for the twining_triage read-model.
 * Registers twining_triage (docs/TRIAGE-SPEC.md §6) — thin adapter over
 * buildTriage; all range/validity normalization lives in the engine (§4.1).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildTriage, type TriageStores } from "../engine/triage.js";
import { toolResult, toolError } from "../utils/errors.js";

export function registerTriageTools(
  server: McpServer,
  stores: TriageStores,
): void {
  // twining_triage — project-wide triage read-model (full surface only in v1, §6)
  server.registerTool(
    "twining_triage",
    {
      description:
        "Project-wide triage read-model: open items awaiting a lifecycle act (provisional decisions; unresolved needs, questions, warnings) and recent activity (newly active decisions, artifact posts) within a time window. Optionally pass for_agent (an agent_id as self-reported to twining_post) to exclude that agent's own outbound posts. Read-only — act via twining_promote / twining_override / twining_reconsider / twining_post.",
      inputSchema: {
        // Numerics are UNCONSTRAINED by design (§4.1): range constraints here
        // would make the tool reject values HTTP silently defaults.
        scope: z
          .string()
          .optional()
          .describe(
            "Filter items by declared scope (bidirectional prefix match)",
          ),
        window_ms: z
          .number()
          .optional()
          .describe(
            "Time window for recent activity in milliseconds (default: 7 days)",
          ),
        section: z
          .enum(["all", "open", "recent"])
          .optional()
          .describe('Which bucket(s) to return (default: "all")'),
        limit: z
          .number()
          .optional()
          .describe("Maximum items per bucket (default: 25, max: 200)"),
        since: z
          .string()
          .optional()
          .describe(
            "ISO timestamp cursor — only recent items strictly after this instant; pass the previous result's generated_at",
          ),
        for_agent: z
          .string()
          .optional()
          .describe(
            "Exclude this agent's own outbound blackboard posts (matches self-reported agent_id)",
          ),
      },
    },
    async (args) => {
      try {
        const result = await buildTriage(stores, args);
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
