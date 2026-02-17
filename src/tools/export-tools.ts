/**
 * MCP tool handlers for export operations.
 * Registers twining_export for full state snapshot as markdown.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Exporter } from "../engine/exporter.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerExportTools(
  server: McpServer,
  exporter: Exporter,
): void {
  // twining_export — Export full Twining state as markdown
  server.registerTool(
    "twining_export",
    {
      description:
        "Export full Twining state as a single markdown document. Includes blackboard entries, decisions with full rationale, and knowledge graph entities/relations. Use for handoff between context windows, documentation, or debugging.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe(
            "Optional scope filter to export only a subset of state (e.g., 'src/auth/'). If omitted, exports everything.",
          ),
      },
    },
    async (args) => {
      try {
        const result = await exporter.exportMarkdown(args.scope);
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
