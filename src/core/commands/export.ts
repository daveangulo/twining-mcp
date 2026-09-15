/**
 * Export command: twining_export.
 * Extracted verbatim from src/tools/export-tools.ts.
 */
import { z } from "zod";
import type { Exporter } from "../../engine/exporter.js";
import { commandFactory, type CommandDef } from "../command-def.js";

export interface ExportCtx {
  exporter: Exporter;
}

const { define } = commandFactory<ExportCtx>();

export const exportCommands: CommandDef<ExportCtx>[] = [
  define({
    name: "twining_export",
    surface: "full",
    description:
      "Export full Twining state as a single markdown document. Includes blackboard entries, decisions with full rationale, and knowledge graph entities/relations. Use for handoff between context windows, documentation, or debugging.",
    input: {
      scope: z
        .string()
        .optional()
        .describe(
          "Optional scope filter to export only a subset of state (e.g., 'src/auth/'). If omitted, exports everything.",
        ),
    },
    async handler(ctx, args) {
      return await ctx.exporter.exportMarkdown(args.scope);
    },
  }),
];
