/**
 * Decision hygiene scorer: checks decision workflow patterns.
 *
 * For each twining_decide call:
 * - Check if twining_assemble appears earlier in sequence (MUST per ASSEMBLE-01)
 * - Check if twining_link_commit appears later (SHOULD)
 * - Check alternatives_considered field populated (MUST per DECIDE-02)
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";

export const decisionHygieneScorer: Scorer = {
  name: "decision-hygiene",
  score(input: ScorerInput, _spec: BehaviorSpec): ScorerResult {
    if (input.calls.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const checks: CheckResult[] = [];

    // Find all decide calls
    const decideCalls = input.calls.filter((c) => c.tool === "twining_decide");

    for (const decide of decideCalls) {
      // Check for preceding assemble (blind-decisions)
      const hasAssembleBefore = input.calls.some(
        (c) => c.tool === "twining_assemble" && c.index < decide.index,
      );
      checks.push({
        ruleId: "ASSEMBLE-01",
        level: "MUST",
        passed: hasAssembleBefore,
        message: hasAssembleBefore
          ? "Decision preceded by context assembly"
          : "Blind decision: no twining_assemble before twining_decide",
      });

      // Check for following link_commit (fire-and-forget)
      const hasLinkCommitAfter = input.calls.some(
        (c) => c.tool === "twining_link_commit" && c.index > decide.index,
      );
      checks.push({
        ruleId: "LINK-COMMIT",
        level: "SHOULD",
        passed: hasLinkCommitAfter,
        message: hasLinkCommitAfter
          ? "Decision followed by commit linkage"
          : "Fire-and-forget: no twining_link_commit after twining_decide",
      });

      // Check alternatives_considered populated
      const alternatives = decide.arguments["alternatives_considered"];
      const hasAlternatives =
        (Array.isArray(alternatives) && alternatives.length > 0) ||
        (typeof alternatives === "string" && alternatives.trim().length > 0);
      checks.push({
        ruleId: "DECIDE-02",
        level: "MUST",
        passed: hasAlternatives,
        message: hasAlternatives
          ? "Decision includes alternatives considered"
          : "Decision missing alternatives_considered",
      });
    }

    // No decide calls found -- vacuous pass
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
