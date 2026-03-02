/**
 * Anti-patterns scorer: detects behavioral anti-patterns from BehaviorSpec.
 *
 * Checks for each anti-pattern by ID:
 * - "fire-and-forget-decisions": twining_decide without twining_link_commit following
 * - "scope-inflation": any scope arg matching overly-broad patterns
 * - "rationale-poverty": twining_decide with rationale < 20 chars or generic text
 * - "blind-decisions": twining_decide without preceding twining_assemble
 * - "blackboard-spam": more than 5 twining_post calls in sequence
 *
 * Each detection maps to an anti-pattern ID from BehaviorSpec.
 * Anti-pattern found: check fails. Anti-pattern absent: check passes.
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";

/** Broad scope patterns. */
const BROAD_SCOPES = new Set(["project", ".", "/", ""]);

/** Vague rationale patterns. */
const VAGUE_RATIONALES = [
  "seemed right",
  "best option",
  "standard approach",
  "obvious choice",
];

type AntiPatternChecker = (input: ScorerInput) => boolean;

const CHECKERS: Record<string, AntiPatternChecker> = {
  "fire-and-forget-decisions": (input) => {
    const decideCalls = input.calls.filter((c) => c.tool === "twining_decide");
    if (decideCalls.length === 0) return false;
    // Detected if ANY decide lacks a following link_commit
    return decideCalls.some(
      (d) =>
        !input.calls.some(
          (c) => c.tool === "twining_link_commit" && c.index > d.index,
        ),
    );
  },

  "scope-inflation": (input) => {
    return input.calls.some((c) => {
      const scope = c.arguments["scope"];
      return typeof scope === "string" && BROAD_SCOPES.has(scope.trim().toLowerCase());
    });
  },

  "rationale-poverty": (input) => {
    const decideCalls = input.calls.filter((c) => c.tool === "twining_decide");
    if (decideCalls.length === 0) return false;
    return decideCalls.some((d) => {
      const rationale = d.arguments["rationale"];
      if (typeof rationale !== "string") return true;
      const lower = rationale.trim().toLowerCase();
      return lower.length < 20 || VAGUE_RATIONALES.some((v) => lower === v);
    });
  },

  "blind-decisions": (input) => {
    const decideCalls = input.calls.filter((c) => c.tool === "twining_decide");
    if (decideCalls.length === 0) return false;
    return decideCalls.some(
      (d) =>
        !input.calls.some(
          (c) => c.tool === "twining_assemble" && c.index < d.index,
        ),
    );
  },

  "blackboard-spam": (input) => {
    // Check for more than 5 consecutive twining_post calls
    let consecutive = 0;
    for (const call of input.calls) {
      if (call.tool === "twining_post") {
        consecutive++;
        if (consecutive > 5) return true;
      } else {
        consecutive = 0;
      }
    }
    return false;
  },
};

export const antiPatternsScorer: Scorer = {
  name: "anti-patterns",
  async score(input: ScorerInput, spec: BehaviorSpec): Promise<ScorerResult> {
    if (input.calls.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const checks: CheckResult[] = [];

    for (const pattern of spec.antiPatterns) {
      const checker = CHECKERS[pattern.id];
      if (!checker) continue;

      const detected = checker(input);
      checks.push({
        ruleId: `AP-${pattern.id}`,
        level: "SHOULD",
        passed: !detected,
        message: detected
          ? `Anti-pattern "${pattern.id}" detected: ${pattern.description}`
          : `Anti-pattern "${pattern.id}" not detected`,
      });
    }

    // No anti-pattern checks applicable -- vacuous pass
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
