/**
 * Argument quality scorer: checks tool argument content quality.
 *
 * - twining_decide: rationale present and non-empty (MUST per DECIDE-01),
 *   alternatives_considered present (MUST per DECIDE-02)
 * - twining_post: summary under 200 chars (SHOULD per POST-04)
 * - twining_add_entity: name is specific (MUST per ENTITY-01)
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";

/** Generic/vague rationale patterns. */
const VAGUE_RATIONALES = [
  "seemed right",
  "best option",
  "standard approach",
  "obvious choice",
];

function isVagueRationale(rationale: string): boolean {
  const lower = rationale.trim().toLowerCase();
  return lower.length === 0 || VAGUE_RATIONALES.some((v) => lower === v);
}

export const argumentQualityScorer: Scorer = {
  name: "argument-quality",
  async score(input: ScorerInput, _spec: BehaviorSpec): Promise<ScorerResult> {
    if (input.calls.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const checks: CheckResult[] = [];

    for (const call of input.calls) {
      // twining_decide checks
      if (call.tool === "twining_decide") {
        // DECIDE-01: rationale present and non-trivial
        const rationale = call.arguments["rationale"];
        const hasRationale =
          typeof rationale === "string" && !isVagueRationale(rationale);
        checks.push({
          ruleId: "DECIDE-01",
          level: "MUST",
          passed: hasRationale,
          message: hasRationale
            ? "Decision has specific rationale"
            : "Decision missing or has vague rationale",
        });

        // DECIDE-02: alternatives_considered present
        const alternatives = call.arguments["alternatives_considered"];
        const hasAlternatives =
          (Array.isArray(alternatives) && alternatives.length > 0) ||
          (typeof alternatives === "string" && alternatives.trim().length > 0);
        checks.push({
          ruleId: "DECIDE-02",
          level: "MUST",
          passed: hasAlternatives,
          message: hasAlternatives
            ? "Decision includes alternatives"
            : "Decision missing alternatives_considered",
        });
      }

      // twining_post checks
      if (call.tool === "twining_post") {
        const summary = call.arguments["summary"];
        if (typeof summary === "string") {
          const underLimit = summary.length <= 200;
          checks.push({
            ruleId: "POST-04",
            level: "SHOULD",
            passed: underLimit,
            message: underLimit
              ? "Post summary within 200 char limit"
              : `Post summary exceeds 200 chars (${summary.length})`,
          });
        }
      }

      // twining_add_entity checks
      if (call.tool === "twining_add_entity") {
        const name = call.arguments["name"];
        const genericNames = ["helper", "utils", "module", "service", "handler"];
        const isGeneric =
          typeof name === "string" &&
          genericNames.includes(name.trim().toLowerCase());
        const isSpecific = typeof name === "string" && name.trim().length > 0 && !isGeneric;
        checks.push({
          ruleId: "ENTITY-01",
          level: "MUST",
          passed: isSpecific,
          message: isSpecific
            ? `Entity name "${name}" is specific`
            : `Entity name "${name ?? "(empty)"}" is too generic or missing`,
        });
      }
    }

    // No relevant calls found -- vacuous pass
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
