/**
 * Unit tests for all 7 category scorers using synthetic ScorerInput fixtures.
 *
 * Tests validate that scorers:
 * - Implement the Scorer interface (name, score method returning ScorerResult)
 * - Produce correctly structured ScorerResult with CheckResult entries
 * - Pass on happy-path inputs and fail on violation inputs
 * - Reference rule IDs traceable to BEHAVIORS.md
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import { allScorers } from "./index.js";
import { sequencingScorer } from "./sequencing.js";
import { scopeQualityScorer } from "./scope-quality.js";
import { argumentQualityScorer } from "./argument-quality.js";
import { decisionHygieneScorer } from "./decision-hygiene.js";
import { workflowCompletenessScorer } from "./workflow-completeness.js";
import { antiPatternsScorer } from "./anti-patterns.js";
import { qualityCriteriaScorer } from "./quality-criteria.js";

import { aggregateChecks } from "../scorer-types.js";
import type { ScorerInput, NormalizedToolCall } from "../scenario-schema.js";
import type { BehaviorSpec } from "../types.js";
import { parseBehaviors } from "../behaviors-parser.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Helper to create a NormalizedToolCall. */
function call(
  tool: string,
  args: Record<string, unknown>,
  index: number,
): NormalizedToolCall {
  return { tool: `twining_${tool}`, arguments: args, index };
}

/** Happy path orient: status -> assemble -> why with good scopes. */
const happyOrient: ScorerInput = {
  calls: [
    call("status", { scope: "src/engine/blackboard.ts" }, 0),
    call("assemble", { scope: "src/engine/blackboard.ts", depth: 2 }, 1),
    call("why", { scope: "src/engine/blackboard.ts" }, 2),
  ],
};

/** Happy path decide: assemble -> decide (with rationale + alternatives) -> link_commit. */
const happyDecide: ScorerInput = {
  calls: [
    call("assemble", { scope: "src/tools/decide.ts", depth: 2 }, 0),
    call(
      "decide",
      {
        summary: "Use JWT for auth",
        rationale:
          "JWT provides stateless authentication with built-in expiration, avoiding database lookups for token validation",
        alternatives_considered: [
          "Session-based auth with Redis store",
          "OAuth2 with external provider",
        ],
        scope: "src/auth/",
      },
      1,
    ),
    call(
      "link_commit",
      { commit_sha: "abc123", decision_id: "dec-001", scope: "src/auth/" },
      2,
    ),
  ],
};

/** Bad decide: decide with no rationale, no assemble before, no link_commit after. */
const badDecide: ScorerInput = {
  calls: [
    call(
      "decide",
      {
        summary: "Use JWT",
        rationale: "",
        scope: "src/auth/",
      },
      0,
    ),
  ],
};

/** Broad scope: post with scope "project". */
const broadScope: ScorerInput = {
  calls: [
    call(
      "post",
      {
        summary: "Status update",
        scope: "project",
      },
      0,
    ),
  ],
};

/** Empty sequence: no calls at all. */
const emptySequence: ScorerInput = {
  calls: [],
};

// ---------------------------------------------------------------------------
// Load real BehaviorSpec from BEHAVIORS.md
// ---------------------------------------------------------------------------

let spec: BehaviorSpec;

beforeAll(() => {
  const behaviorsPath = resolve(
    import.meta.dirname,
    "../../../plugin/BEHAVIORS.md",
  );
  const markdown = readFileSync(behaviorsPath, "utf-8");
  spec = parseBehaviors(markdown);
});

// ---------------------------------------------------------------------------
// Structural Tests
// ---------------------------------------------------------------------------

describe("scorer registry", () => {
  it("allScorers contains exactly 7 scorers", () => {
    expect(allScorers).toHaveLength(7);
  });

  it("all scorers have unique names", () => {
    const names = allScorers.map((s) => s.name);
    expect(new Set(names).size).toBe(7);
  });

  it.each(allScorers.map((s) => [s.name, s]))(
    "%s returns properly structured ScorerResult",
    (_name, scorer) => {
      const result = scorer.score(happyOrient, spec);
      expect(result).toHaveProperty("scorer");
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("passed");
      expect(result).toHaveProperty("checks");
      expect(typeof result.scorer).toBe("string");
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(typeof result.passed).toBe("boolean");
      expect(Array.isArray(result.checks)).toBe(true);
    },
  );

  it.each(allScorers.map((s) => [s.name, s]))(
    "%s returns score 1.0 for empty sequence (vacuous truth)",
    (_name, scorer) => {
      const result = scorer.score(emptySequence, spec);
      expect(result.score).toBe(1);
      expect(result.passed).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Sequencing Scorer
// ---------------------------------------------------------------------------

describe("sequencing scorer", () => {
  it("passes when calls follow workflow step order", () => {
    const result = sequencingScorer.score(happyOrient, spec);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("fails when calls are out of order", () => {
    const outOfOrder: ScorerInput = {
      calls: [
        call("why", { scope: "src/" }, 0),
        call("status", { scope: "src/" }, 1),
        call("assemble", { scope: "src/" }, 2),
      ],
    };
    const result = sequencingScorer.score(outOfOrder, spec);
    expect(result.score).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Scope Quality Scorer
// ---------------------------------------------------------------------------

describe("scope quality scorer", () => {
  it("passes when scopes are specific file paths", () => {
    const result = scopeQualityScorer.score(happyOrient, spec);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("fails when scope is overly broad", () => {
    const result = scopeQualityScorer.score(broadScope, spec);
    expect(result.score).toBeLessThan(1);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Argument Quality Scorer
// ---------------------------------------------------------------------------

describe("argument quality scorer", () => {
  it("passes when arguments are well-formed", () => {
    const result = argumentQualityScorer.score(happyDecide, spec);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("fails when decide call has empty rationale", () => {
    const result = argumentQualityScorer.score(badDecide, spec);
    expect(result.score).toBeLessThan(1);
    expect(result.checks.some((c) => !c.passed && c.level === "MUST")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Decision Hygiene Scorer
// ---------------------------------------------------------------------------

describe("decision hygiene scorer", () => {
  it("passes when decide has assemble before and link_commit after", () => {
    const result = decisionHygieneScorer.score(happyDecide, spec);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("fails when decide has no preceding assemble (blind decision)", () => {
    const result = decisionHygieneScorer.score(badDecide, spec);
    expect(result.score).toBeLessThan(1);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });

  it("fails when decide is not followed by link_commit (fire-and-forget)", () => {
    const noLinkCommit: ScorerInput = {
      calls: [
        call("assemble", { scope: "src/" }, 0),
        call(
          "decide",
          {
            summary: "Use JWT",
            rationale: "JWT provides stateless authentication with built-in expiration",
            alternatives_considered: ["Session auth", "OAuth2"],
          },
          1,
        ),
      ],
    };
    const result = decisionHygieneScorer.score(noLinkCommit, spec);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workflow Completeness Scorer
// ---------------------------------------------------------------------------

describe("workflow completeness scorer", () => {
  it("passes when workflow steps are complete", () => {
    const result = workflowCompletenessScorer.score(happyOrient, spec);
    expect(result.passed).toBe(true);
  });

  it("detects incomplete workflows", () => {
    // Only status, missing assemble
    const partial: ScorerInput = {
      calls: [call("status", { scope: "src/" }, 0)],
    };
    const result = workflowCompletenessScorer.score(partial, spec);
    // Should still run without error even if not all steps present
    expect(result).toHaveProperty("score");
  });
});

// ---------------------------------------------------------------------------
// Anti-Patterns Scorer
// ---------------------------------------------------------------------------

describe("anti-patterns scorer", () => {
  it("passes when no anti-patterns detected", () => {
    const result = antiPatternsScorer.score(happyDecide, spec);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("detects blind-decisions (decide without assemble)", () => {
    const result = antiPatternsScorer.score(badDecide, spec);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });

  it("detects fire-and-forget (decide without link_commit)", () => {
    const fireAndForget: ScorerInput = {
      calls: [
        call("assemble", { scope: "src/" }, 0),
        call(
          "decide",
          {
            summary: "Use JWT",
            rationale: "JWT provides stateless auth",
            alternatives_considered: ["Session auth"],
          },
          1,
        ),
      ],
    };
    const result = antiPatternsScorer.score(fireAndForget, spec);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });

  it("detects scope-inflation", () => {
    const result = antiPatternsScorer.score(broadScope, spec);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });

  it("detects rationale-poverty", () => {
    const shortRationale: ScorerInput = {
      calls: [
        call("assemble", { scope: "src/" }, 0),
        call(
          "decide",
          {
            summary: "Use JWT",
            rationale: "because",
            alternatives_considered: ["other"],
          },
          1,
        ),
        call("link_commit", { commit_sha: "abc", decision_id: "d1" }, 2),
      ],
    };
    const result = antiPatternsScorer.score(shortRationale, spec);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quality Criteria Scorer
// ---------------------------------------------------------------------------

describe("quality criteria scorer", () => {
  it("passes when quality criteria met", () => {
    const result = qualityCriteriaScorer.score(happyDecide, spec);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("fails on broad scope (scope-precision)", () => {
    const result = qualityCriteriaScorer.score(broadScope, spec);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aggregateChecks utility
// ---------------------------------------------------------------------------

describe("aggregateChecks", () => {
  it("returns 1.0 for empty checks", () => {
    expect(aggregateChecks([])).toBe(1.0);
  });

  it("returns 1.0 for all passing checks", () => {
    const checks = [
      { ruleId: "A-01", level: "MUST" as const, passed: true, message: "ok" },
      {
        ruleId: "A-02",
        level: "SHOULD" as const,
        passed: true,
        message: "ok",
      },
    ];
    expect(aggregateChecks(checks)).toBe(1.0);
  });

  it("returns 0.5 for one MUST fail and one pass", () => {
    const checks = [
      {
        ruleId: "A-01",
        level: "MUST" as const,
        passed: false,
        message: "fail",
      },
      {
        ruleId: "A-02",
        level: "MUST" as const,
        passed: true,
        message: "pass",
      },
    ];
    expect(aggregateChecks(checks)).toBe(0.5);
  });

  it("returns 0.75 for one SHOULD fail and one pass", () => {
    const checks = [
      {
        ruleId: "A-01",
        level: "SHOULD" as const,
        passed: false,
        message: "fail",
      },
      {
        ruleId: "A-02",
        level: "SHOULD" as const,
        passed: true,
        message: "pass",
      },
    ];
    expect(aggregateChecks(checks)).toBe(0.75);
  });

  it("returns 0 for all MUST failures", () => {
    const checks = [
      {
        ruleId: "A-01",
        level: "MUST" as const,
        passed: false,
        message: "fail",
      },
    ];
    expect(aggregateChecks(checks)).toBe(0);
  });
});
