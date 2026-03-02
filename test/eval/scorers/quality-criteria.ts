/**
 * Quality criteria scorer: checks quality criterion compliance from BehaviorSpec.
 *
 * For each quality criterion in spec.qualityCriteria:
 * - "scope-precision": check scope args for path specificity (SHOULD)
 * - "rationale-quality": check rationale text length and specificity (SHOULD)
 * - "parameter-content": check that tool-specific required fields are non-empty (SHOULD)
 * - "alternative-depth": check alternatives_considered has 2+ items or substantive text (SHOULD)
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";

/** Broad scope patterns. */
const BROAD_SCOPES = new Set(["project", ".", "/", ""]);

type CriterionChecker = (input: ScorerInput) => CheckResult | null;

const CRITERION_CHECKERS: Record<string, CriterionChecker> = {
  "scope-precision": (input) => {
    // Check all calls with scope argument
    const scopedCalls = input.calls.filter(
      (c) => typeof c.arguments["scope"] === "string",
    );
    if (scopedCalls.length === 0) return null;

    const allSpecific = scopedCalls.every((c) => {
      const scope = (c.arguments["scope"] as string).trim().toLowerCase();
      return !BROAD_SCOPES.has(scope);
    });

    return {
      ruleId: "QC-scope-precision",
      level: "SHOULD",
      passed: allSpecific,
      message: allSpecific
        ? "All scope arguments are specific"
        : "Some scope arguments are overly broad",
    };
  },

  "rationale-quality": (input) => {
    const decideCalls = input.calls.filter((c) => c.tool === "twining_decide");
    if (decideCalls.length === 0) return null;

    const allSubstantive = decideCalls.every((d) => {
      const rationale = d.arguments["rationale"];
      if (typeof rationale !== "string") return false;
      // Substantive: >30 chars and not generic
      return rationale.trim().length > 30;
    });

    return {
      ruleId: "QC-rationale-quality",
      level: "SHOULD",
      passed: allSubstantive,
      message: allSubstantive
        ? "All rationale text is substantive"
        : "Some rationale text is too short or generic",
    };
  },

  "parameter-content": (input) => {
    // Check that tool-specific required fields are non-empty
    const issues: string[] = [];

    for (const call of input.calls) {
      if (call.tool === "twining_decide") {
        const summary = call.arguments["summary"];
        if (typeof summary !== "string" || summary.trim().length === 0) {
          issues.push("decide call missing summary");
        }
      }
      if (call.tool === "twining_post") {
        const summary = call.arguments["summary"];
        if (typeof summary !== "string" || summary.trim().length === 0) {
          issues.push("post call missing summary");
        }
      }
      if (call.tool === "twining_add_entity") {
        const name = call.arguments["name"];
        if (typeof name !== "string" || name.trim().length === 0) {
          issues.push("entity call missing name");
        }
      }
    }

    // Only produce a check if we found relevant calls
    const relevantCalls = input.calls.filter(
      (c) =>
        c.tool === "twining_decide" ||
        c.tool === "twining_post" ||
        c.tool === "twining_add_entity",
    );
    if (relevantCalls.length === 0) return null;

    const passed = issues.length === 0;
    return {
      ruleId: "QC-parameter-content",
      level: "SHOULD",
      passed,
      message: passed
        ? "All required parameters populated"
        : `Parameter issues: ${issues.join("; ")}`,
    };
  },

  "alternative-depth": (input) => {
    const decideCalls = input.calls.filter((c) => c.tool === "twining_decide");
    if (decideCalls.length === 0) return null;

    const allDeep = decideCalls.every((d) => {
      const alternatives = d.arguments["alternatives_considered"];
      if (Array.isArray(alternatives)) return alternatives.length >= 2;
      if (typeof alternatives === "string")
        return alternatives.trim().length > 30;
      return false;
    });

    return {
      ruleId: "QC-alternative-depth",
      level: "SHOULD",
      passed: allDeep,
      message: allDeep
        ? "Alternatives have sufficient depth"
        : "Alternatives lack depth (need 2+ items or substantive text)",
    };
  },
};

export const qualityCriteriaScorer: Scorer = {
  name: "quality-criteria",
  score(input: ScorerInput, spec: BehaviorSpec): ScorerResult {
    if (input.calls.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const checks: CheckResult[] = [];

    for (const criterion of spec.qualityCriteria) {
      const checker = CRITERION_CHECKERS[criterion.name];
      if (!checker) continue;

      const result = checker(input);
      if (result) {
        checks.push(result);
      }
    }

    // No criteria applicable -- vacuous pass
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
