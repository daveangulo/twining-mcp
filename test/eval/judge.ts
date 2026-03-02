/**
 * LLM-as-judge wrapper: Anthropic SDK integration with structured tool_use
 * and k-trial consensus scoring.
 *
 * This module provides the foundation for LLM-based evaluation:
 * - createJudgeClient(): Safe client creation (null if no API key)
 * - callJudge(): Single LLM evaluation via structured tool_use
 * - consensusScore(): k-trial consensus with majority voting
 * - buildRubricPrompt(): Prompt construction from quality criteria
 *
 * IMPORTANT: createJudgeClient() is the safety gate -- returns null when
 * ANTHROPIC_API_KEY is not set, so callers can skip LLM scoring gracefully.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { QualityCriterion } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from a single LLM judge evaluation. */
export interface JudgeResult {
  /** Quality level: "good", "acceptable", or "bad". */
  level: string;
  /** LLM's reasoning for the assigned level. */
  reasoning: string;
}

/** Result from k-trial consensus scoring. */
export interface ConsensusResult {
  /** Numeric score 0-1 derived from consensus level or median. */
  score: number;
  /** Consensus quality level (majority vote winner). */
  level: string;
  /** Agreement ratio, e.g. "2/3" or "3/3". */
  agreement: string;
  /** Individual trial results. */
  trials: JudgeResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps quality levels to numeric scores. */
export const LEVEL_SCORES: Record<string, number> = {
  good: 1.0,
  acceptable: 0.5,
  bad: 0.0,
};

/** Anthropic tool schema for structured judge output. */
export const JUDGE_TOOL: Anthropic.Tool = {
  name: "judge_result",
  description:
    "Report your quality assessment of the agent's tool usage. You MUST call this tool with your evaluation.",
  input_schema: {
    type: "object" as const,
    properties: {
      level: {
        type: "string",
        enum: ["good", "acceptable", "bad"],
        description:
          "Quality level: good (follows best practices), acceptable (minor issues), bad (significant problems)",
      },
      reasoning: {
        type: "string",
        description:
          "Brief explanation of why this level was assigned, citing specific observations",
      },
    },
    required: ["level", "reasoning"],
  },
};

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Convert a quality level string to a numeric score.
 * Returns 0.0 for unknown levels.
 */
export function levelToScore(level: string): number {
  return LEVEL_SCORES[level] ?? 0.0;
}

/**
 * Compute the median of a numeric array.
 * Returns the middle value for odd-length arrays, or the average of the
 * two middle values for even-length arrays.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Client Creation
// ---------------------------------------------------------------------------

/**
 * Create an Anthropic client if ANTHROPIC_API_KEY is available.
 * Returns null if the key is not set -- callers should skip LLM scoring.
 * The SDK auto-reads the key from the environment.
 */
export function createJudgeClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    return null;
  }
  return new Anthropic();
}

// ---------------------------------------------------------------------------
// Single Judge Call
// ---------------------------------------------------------------------------

/**
 * Call the LLM judge with a prompt and extract structured result via tool_use.
 *
 * Uses structured tool_use (tool_choice forced) to ensure the model returns
 * a valid JudgeResult. Throws if the response contains no tool_use block.
 *
 * @param client - Anthropic client instance
 * @param prompt - The evaluation prompt (should include rubric and context)
 * @returns JudgeResult with level and reasoning
 */
export async function callJudge(
  client: Anthropic,
  prompt: string,
): Promise<JudgeResult> {
  const model =
    process.env.TWINING_EVAL_MODEL ?? "claude-haiku-4-5-20250929";

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    temperature: 0,
    tool_choice: { type: "tool", name: "judge_result" },
    tools: [JUDGE_TOOL],
    messages: [{ role: "user", content: prompt }],
  });

  // Find the tool_use block in the response
  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use",
  );

  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    throw new Error(
      "Judge response did not contain a tool_use block. " +
        `Got content types: [${response.content.map((b) => b.type).join(", ")}]`,
    );
  }

  const input = toolUseBlock.input as { level: string; reasoning: string };
  return {
    level: input.level,
    reasoning: input.reasoning,
  };
}

// ---------------------------------------------------------------------------
// Consensus Scoring
// ---------------------------------------------------------------------------

/**
 * Run k trials of the judge function and compute a consensus score.
 *
 * Strategy:
 * 1. Fire k trials in parallel
 * 2. Count level occurrences, find majority (>= ceil(k/2))
 * 3. If majority exists, use levelToScore(majorityLevel)
 * 4. Otherwise use median of all trial scores
 *
 * @param judgeFn - Function that returns a single JudgeResult
 * @param k - Number of trials (default: TWINING_EVAL_TRIALS env var, or 3)
 * @returns ConsensusResult with score, level, agreement ratio, and trials
 */
export async function consensusScore(
  judgeFn: () => Promise<JudgeResult>,
  k?: number,
): Promise<ConsensusResult> {
  const trials =
    k ??
    (process.env.TWINING_EVAL_TRIALS
      ? parseInt(process.env.TWINING_EVAL_TRIALS, 10)
      : 3);

  // Fire all trials in parallel
  const results = await Promise.all(
    Array.from({ length: trials }, () => judgeFn()),
  );

  // Count level occurrences
  const counts = new Map<string, number>();
  for (const result of results) {
    counts.set(result.level, (counts.get(result.level) ?? 0) + 1);
  }

  // Find majority (>= ceil(k/2))
  const majorityThreshold = Math.ceil(trials / 2);
  let majorityLevel: string | null = null;
  let majorityCount = 0;

  for (const [level, count] of counts) {
    if (count >= majorityThreshold && count > majorityCount) {
      majorityLevel = level;
      majorityCount = count;
    }
  }

  // Compute score
  let score: number;
  let level: string;

  if (majorityLevel !== null) {
    score = levelToScore(majorityLevel);
    level = majorityLevel;
  } else {
    // No majority -- use median of individual scores
    const scores = results.map((r) => levelToScore(r.level));
    score = median(scores);
    // Pick the level closest to the median score
    const levelEntries = Object.entries(LEVEL_SCORES);
    level =
      levelEntries.reduce((closest, [l, s]) =>
        Math.abs(s - score) < Math.abs(LEVEL_SCORES[closest[0]]! - score)
          ? [l, s]
          : closest,
      )[0] ?? "bad";
  }

  return {
    score,
    level,
    agreement: `${majorityCount || Math.max(...counts.values())}/${trials}`,
    trials: results,
  };
}

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

/**
 * Build an evaluation prompt from a quality criterion and tool call context.
 *
 * Constructs a structured prompt with:
 * - The criterion name
 * - Rubric levels formatted as a grading scale
 * - The tool call context to evaluate
 *
 * @param criterion - Quality criterion with levels from BEHAVIORS.md
 * @param context - Stringified tool call context to evaluate
 * @returns Formatted prompt string for callJudge
 */
export function buildRubricPrompt(
  criterion: QualityCriterion,
  context: string,
): string {
  const rubricLines = criterion.levels
    .map(
      (lvl) =>
        `- **${lvl.level}**: ${lvl.description}\n  Example: ${lvl.example}`,
    )
    .join("\n");

  return `You are evaluating an AI agent's tool usage quality for the criterion: "${criterion.name}".

## Rubric

${rubricLines}

## Tool Call Context

${context}

## Instructions

Evaluate the tool calls above against the "${criterion.name}" rubric. Use the judge_result tool to report your assessment with a level (good, acceptable, or bad) and brief reasoning.`;
}
