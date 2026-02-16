/**
 * MCP tool handlers for context assembly operations.
 * Registers twining_assemble, twining_summarize, and twining_what_changed.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextAssembler } from "../engine/context-assembler.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerContextTools(
  server: McpServer,
  contextAssembler: ContextAssembler,
): void {
  // twining_assemble — Build tailored context for a specific task
  server.registerTool(
    "twining_assemble",
    {
      description:
        "Build tailored context for a specific task. Returns relevant decisions, warnings, needs, findings, and questions within a token budget. Call this before starting any task to get shared context from other agents.",
      inputSchema: {
        task: z.string().describe("Description of what the agent is about to do"),
        scope: z
          .string()
          .describe('File path, module, or area of codebase (e.g., "src/auth/" or "project")'),
        max_tokens: z
          .number()
          .optional()
          .describe("Token budget (default: from config, typically 4000)"),
      },
    },
    async (args) => {
      try {
        const result = await contextAssembler.assemble(
          args.task,
          args.scope,
          args.max_tokens,
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

  // twining_summarize — High-level summary of project or scope state
  server.registerTool(
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

  // twining_what_changed — Report changes since a given point in time
  server.registerTool(
    "twining_what_changed",
    {
      description:
        "Report what changed since a given point in time. Returns new decisions, new entries, overridden decisions, and reconsidered decisions. Use this to catch up on changes since you last checked.",
      inputSchema: {
        since: z
          .string()
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
