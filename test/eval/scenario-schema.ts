/**
 * Zod schema for YAML eval scenario format + normalized types for scorer input.
 *
 * This module defines:
 * - ScenarioSchema: Runtime validation for YAML scenario files
 * - NormalizedToolCall: Format-agnostic tool call representation
 * - ScorerInput: What scorers receive (decoupled from scenario format)
 * - normalizeScenario: Converts a Scenario into ScorerInput
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Scenario Schema (validates YAML scenario files)
// ---------------------------------------------------------------------------

export const ScenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(["orient", "decide", "verify", "coordinate", "handoff"]),
  tags: z.array(z.string()).default([]),
  holdout: z.boolean().default(false),
  tool_calls: z
    .array(
      z.object({
        tool: z.string().startsWith("twining_"),
        arguments: z.record(z.unknown()).default({}),
      }),
    )
    .min(1),
  expected_scores: z.record(z.boolean()).default({}),
});

/** A parsed and validated scenario. */
export type Scenario = z.infer<typeof ScenarioSchema>;

// ---------------------------------------------------------------------------
// Normalized Types (format-agnostic scorer contracts)
// ---------------------------------------------------------------------------

/** A single tool call normalized for scorer consumption. */
export interface NormalizedToolCall {
  /** Tool name, e.g. "twining_decide". */
  tool: string;
  /** Tool arguments as key-value pairs. */
  arguments: Record<string, unknown>;
  /** Zero-based index of this call in the sequence. */
  index: number;
  /** Optional tool result, present when parsed from transcripts. */
  result?: { content: string | null; isError: boolean };
}

/** Input to a scorer -- decoupled from scenario file format. */
export interface ScorerInput {
  /** Ordered tool calls to evaluate. */
  calls: NormalizedToolCall[];
  /** Optional metadata (e.g. scenario name, category). */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Converts a Scenario's tool_calls into a ScorerInput,
 * adding zero-based index to each call and scenario metadata.
 */
export function normalizeScenario(scenario: Scenario): ScorerInput {
  return {
    calls: scenario.tool_calls.map((tc, index) => ({
      tool: tc.tool,
      arguments: tc.arguments,
      index,
    })),
    metadata: {
      category: scenario.category,
      tags: scenario.tags,
    },
  };
}
