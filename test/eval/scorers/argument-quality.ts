/**
 * Argument quality scorer: checks tool argument content quality.
 * STUB -- will be implemented in GREEN phase.
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";

export const argumentQualityScorer: Scorer = {
  name: "argument-quality",
  score(_input: ScorerInput, _spec: BehaviorSpec): ScorerResult {
    const checks: CheckResult[] = [
      { ruleId: "STUB", level: "MUST", passed: false, message: "Not implemented" },
    ];
    const score = aggregateChecks(checks);
    return { scorer: this.name, score, passed: score >= DEFAULT_THRESHOLD, checks };
  },
};
