/**
 * LLM-as-judge scorer for rationale quality.
 *
 * Evaluates the quality of `rationale` and `context` arguments in twining_decide
 * tool calls using the "rationale-quality" criterion from BEHAVIORS.md.
 *
 * - Uses k-trial consensus via judge.ts for robust scoring
 * - Gracefully skips when ANTHROPIC_API_KEY is missing or API errors occur
 * - Processes each decide call independently (one judge call per tool call)
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";
import {
  createJudgeClient,
  callJudge,
  consensusScore,
  buildRubricPrompt,
} from "../judge.js";

/**
 * Build a context string describing a single twining_decide call's rationale
 * for the LLM judge to evaluate.
 */
function buildRationaleContext(
  call: { tool: string; arguments: Record<string, unknown>; index: number },
  metadata?: Record<string, unknown>,
): string {
  const rationale = typeof call.arguments["rationale"] === "string"
    ? call.arguments["rationale"]
    : "not provided";
  const context = typeof call.arguments["context"] === "string"
    ? call.arguments["context"]
    : "not provided";
  const summary = typeof call.arguments["summary"] === "string"
    ? call.arguments["summary"]
    : "not provided";

  let result = `Tool: ${call.tool} (call index ${call.index})
Rationale: ${rationale}
Context: ${context}
Summary: ${summary}`;

  if (metadata) {
    const scenarioName = metadata["name"] ?? metadata["scenario"];
    if (scenarioName) {
      result += `\nScenario: ${String(scenarioName)}`;
    }
    const category = metadata["category"];
    if (category) {
      result += `\nCategory: ${String(category)}`;
    }
  }

  return result;
}

export const rationaleJudgeScorer: Scorer = {
  name: "rationale-judge",

  async score(input: ScorerInput, spec: BehaviorSpec): Promise<ScorerResult> {
    // Find the rationale-quality criterion
    const criterion = spec.qualityCriteria.find(
      (c) => c.name === "rationale-quality",
    );
    if (!criterion) {
      return {
        scorer: this.name,
        score: 1,
        passed: true,
        checks: [],
        type: "llm",
      };
    }

    // Filter to twining_decide calls only
    const decideCalls = input.calls.filter((c) => c.tool === "twining_decide");
    if (decideCalls.length === 0) {
      return {
        scorer: this.name,
        score: 1,
        passed: true,
        checks: [],
        type: "llm",
      };
    }

    // Check for API key availability
    const client = createJudgeClient();
    if (!client) {
      return {
        scorer: this.name,
        score: 1,
        passed: true,
        checks: [
          {
            ruleId: "JUDGE-rationale-skip",
            level: "SHOULD",
            passed: true,
            message: "LLM judge skipped: no API key",
          },
        ],
        type: "llm",
      };
    }

    try {
      const checks: CheckResult[] = [];

      for (const call of decideCalls) {
        const contextString = buildRationaleContext(call, input.metadata);
        const prompt = buildRubricPrompt(criterion, contextString);
        const result = await consensusScore(() => callJudge(client, prompt));

        checks.push({
          ruleId: `JUDGE-rationale-${call.index}`,
          level: "SHOULD",
          passed: result.score >= 0.5,
          message: `${result.level} (${result.agreement} agreement): ${result.trials[0]?.reasoning ?? "no reasoning"}`,
        });
      }

      const score = aggregateChecks(checks);
      return {
        scorer: this.name,
        score,
        passed: score >= DEFAULT_THRESHOLD,
        checks,
        type: "llm",
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      console.warn(`[rationale-judge] LLM judge error: ${message}`);
      return {
        scorer: this.name,
        score: 1,
        passed: true,
        checks: [
          {
            ruleId: "JUDGE-rationale-error",
            level: "SHOULD",
            passed: true,
            message: `LLM judge skipped due to error: ${message}`,
          },
        ],
        type: "llm",
      };
    }
  },
};
