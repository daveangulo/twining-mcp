import { describe, it, expect } from "vitest";
import {
  aggregateChecks,
  DEFAULT_THRESHOLD,
  type CheckResult,
  type ScorerResult,
  type Scorer,
} from "./scorer-types.js";
import type { ScorerInput } from "./scenario-schema.js";
import type { BehaviorSpec } from "./types.js";

describe("CheckResult type", () => {
  it("has ruleId, level, passed, and message fields", () => {
    const check: CheckResult = {
      ruleId: "DECIDE-01",
      level: "MUST",
      passed: true,
      message: "Decision has title",
    };
    expect(check.ruleId).toBe("DECIDE-01");
    expect(check.level).toBe("MUST");
    expect(check.passed).toBe(true);
  });
});

describe("ScorerResult type", () => {
  it("has scorer name, score, passed, and checks", () => {
    const result: ScorerResult = {
      scorer: "decision_quality",
      score: 0.85,
      passed: true,
      checks: [],
    };
    expect(result.scorer).toBe("decision_quality");
    expect(result.score).toBe(0.85);
  });
});

describe("Scorer interface", () => {
  it("has name and score method", () => {
    const mockScorer: Scorer = {
      name: "test_scorer",
      score: (_input: ScorerInput, _spec: BehaviorSpec): ScorerResult => ({
        scorer: "test_scorer",
        score: 1.0,
        passed: true,
        checks: [],
      }),
    };
    expect(mockScorer.name).toBe("test_scorer");
  });
});

describe("aggregateChecks", () => {
  it("returns 1.0 for empty checks array", () => {
    expect(aggregateChecks([])).toBe(1.0);
  });

  it("returns 1.0 when all checks pass", () => {
    const checks: CheckResult[] = [
      { ruleId: "DECIDE-01", level: "MUST", passed: true, message: "OK" },
      { ruleId: "DECIDE-02", level: "SHOULD", passed: true, message: "OK" },
      { ruleId: "DECIDE-03", level: "MUST_NOT", passed: true, message: "OK" },
    ];
    expect(aggregateChecks(checks)).toBe(1.0);
  });

  it("returns 0 when a MUST check fails", () => {
    const checks: CheckResult[] = [
      { ruleId: "DECIDE-01", level: "MUST", passed: false, message: "Fail" },
      { ruleId: "DECIDE-02", level: "SHOULD", passed: true, message: "OK" },
    ];
    expect(aggregateChecks(checks)).toBe(0.5);
  });

  it("returns 0.5 when a SHOULD check fails", () => {
    const checks: CheckResult[] = [
      { ruleId: "DECIDE-01", level: "SHOULD", passed: false, message: "Fail" },
    ];
    expect(aggregateChecks(checks)).toBe(0.5);
  });

  it("returns 0 when a MUST_NOT check fails", () => {
    const checks: CheckResult[] = [
      {
        ruleId: "DECIDE-01",
        level: "MUST_NOT",
        passed: false,
        message: "Fail",
      },
    ];
    expect(aggregateChecks(checks)).toBe(0);
  });

  it("calculates mean across mixed results", () => {
    const checks: CheckResult[] = [
      { ruleId: "DECIDE-01", level: "MUST", passed: true, message: "OK" },
      { ruleId: "DECIDE-02", level: "SHOULD", passed: false, message: "Fail" },
      {
        ruleId: "DECIDE-03",
        level: "MUST_NOT",
        passed: true,
        message: "OK",
      },
      { ruleId: "DECIDE-04", level: "MUST", passed: false, message: "Fail" },
    ];
    // Scores: 1.0, 0.5, 1.0, 0.0 => mean = 2.5/4 = 0.625
    expect(aggregateChecks(checks)).toBe(0.625);
  });

  it("rounds to 4 decimal places", () => {
    const checks: CheckResult[] = [
      { ruleId: "R-01", level: "MUST", passed: true, message: "OK" },
      { ruleId: "R-02", level: "SHOULD", passed: false, message: "Fail" },
      { ruleId: "R-03", level: "MUST", passed: true, message: "OK" },
    ];
    // Scores: 1.0, 0.5, 1.0 => mean = 2.5/3 = 0.8333...
    expect(aggregateChecks(checks)).toBe(0.8333);
  });
});

describe("DEFAULT_THRESHOLD", () => {
  it("is 0.8", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.8);
  });
});
