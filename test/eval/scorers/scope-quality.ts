/**
 * Scope quality scorer: checks scope argument specificity.
 *
 * Finds all tool calls with a "scope" argument. Checks each:
 * - Fail if scope is "project", ".", "/" (too broad) -- SHOULD level
 * - Pass if scope contains a meaningful path segment
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";

/** Broad scope patterns that indicate scope inflation. */
const BROAD_SCOPES = new Set(["project", ".", "/", ""]);

function isBroadScope(scope: string): boolean {
  const normalized = scope.trim().toLowerCase();
  return BROAD_SCOPES.has(normalized);
}

export const scopeQualityScorer: Scorer = {
  name: "scope-quality",
  score(input: ScorerInput, _spec: BehaviorSpec): ScorerResult {
    if (input.calls.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const checks: CheckResult[] = [];

    for (const call of input.calls) {
      const scope = call.arguments["scope"];
      if (typeof scope !== "string") continue;

      const broad = isBroadScope(scope);
      checks.push({
        ruleId: "SCOPE-QUALITY",
        level: "SHOULD",
        passed: !broad,
        message: broad
          ? `Tool ${call.tool} at index ${call.index} has overly broad scope "${scope}"`
          : `Tool ${call.tool} at index ${call.index} has specific scope "${scope}"`,
      });
    }

    // No scope arguments found -- vacuous pass
    if (checks.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const score = aggregateChecks(checks);
    return {
      scorer: this.name,
      score,
      passed: score >= DEFAULT_THRESHOLD,
      checks,
    };
  },
};
