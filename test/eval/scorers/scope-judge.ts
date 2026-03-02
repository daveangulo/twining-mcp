/**
 * LLM-as-judge scorer for scope appropriateness.
 *
 * Evaluates whether `scope` arguments are contextually appropriate for the
 * task at hand, using the "scope-precision" criterion from BEHAVIORS.md.
 *
 * - Uses k-trial consensus via judge.ts for robust scoring
 * - Gracefully skips when ANTHROPIC_API_KEY is missing or API errors occur
 * - Processes each scoped call independently (one judge call per tool call)
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
 * Build a context string describing a single tool call's scope argument
 * for the LLM judge to evaluate.
 */
function buildScopeContext(
  call: { tool: string; arguments: Record<string, unknown>; index: number },
  metadata?: Record<string, unknown>,
): string {
  const scope = String(call.arguments["scope"]);

  // Gather other arguments for context depending on tool
  const otherArgs: string[] = [];

  const summary = call.arguments["summary"];
  if (typeof summary === "string") {
    otherArgs.push(`Summary: ${summary}`);
  }

  const category = call.arguments["category"];
  if (typeof category === "string") {
    otherArgs.push(`Category: ${category}`);
  }

  const query = call.arguments["query"];
  if (typeof query === "string") {
    otherArgs.push(`Query: ${query}`);
  }

  const rationale = call.arguments["rationale"];
  if (typeof rationale === "string") {
    otherArgs.push(`Rationale: ${rationale}`);
  }

  let result = `Tool: ${call.tool} (call index ${call.index})
Scope: ${scope}`;

  if (otherArgs.length > 0) {
    result += `\n${otherArgs.join("\n")}`;
  }

  if (metadata) {
    const scenarioName = metadata["name"] ?? metadata["scenario"];
    if (scenarioName) {
      result += `\nScenario: ${String(scenarioName)}`;
    }
    const metaCategory = metadata["category"];
    if (metaCategory) {
      result += `\nCategory: ${String(metaCategory)}`;
    }
  }

  return result;
}

export const scopeJudgeScorer: Scorer = {
  name: "scope-judge",

  async score(input: ScorerInput, spec: BehaviorSpec): Promise<ScorerResult> {
    // Find the scope-precision criterion
    const criterion = spec.qualityCriteria.find(
      (c) => c.name === "scope-precision",
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

    // Filter to calls with a string scope argument
    const scopedCalls = input.calls.filter(
      (c) => typeof c.arguments["scope"] === "string",
    );
    if (scopedCalls.length === 0) {
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
            ruleId: "JUDGE-scope-skip",
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

      for (const call of scopedCalls) {
        const contextString = buildScopeContext(call, input.metadata);
        const prompt = buildRubricPrompt(criterion, contextString);
        const result = await consensusScore(() => callJudge(client, prompt));

        checks.push({
          ruleId: `JUDGE-scope-${call.index}`,
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
      console.warn(`[scope-judge] LLM judge error: ${message}`);
      return {
        scorer: this.name,
        score: 1,
        passed: true,
        checks: [
          {
            ruleId: "JUDGE-scope-error",
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
