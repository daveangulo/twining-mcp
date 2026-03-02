/**
 * Scorer interface, result types, and utility functions for the eval harness.
 *
 * This module defines the contracts that all scorers implement:
 * - Scorer: Interface with name and score() method
 * - ScorerResult: What score() returns
 * - CheckResult: Individual rule check outcome
 * - aggregateChecks: Weighted severity aggregation
 *
 * IMPORTANT: This module only imports ScorerInput from scenario-schema
 * to keep scorers decoupled from the scenario format.
 */
import type { BehaviorSpec } from "./types.js";
import type { ScorerInput } from "./scenario-schema.js";

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

/** Outcome of checking a single behavioral rule. */
export interface CheckResult {
  /** Rule identifier, e.g. "DECIDE-01". */
  ruleId: string;
  /** Severity level of the rule. */
  level: "MUST" | "SHOULD" | "MUST_NOT";
  /** Whether the rule was satisfied. */
  passed: boolean;
  /** Human-readable explanation. */
  message: string;
}

/** Result from a single scorer evaluating a scenario. */
export interface ScorerResult {
  /** Scorer name (matches Scorer.name). */
  scorer: string;
  /** Numeric score 0-1. */
  score: number;
  /** Whether the score meets the threshold. */
  passed: boolean;
  /** Individual rule check outcomes. */
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Scorer Interface
// ---------------------------------------------------------------------------

/** Contract for all eval scorers. */
export interface Scorer {
  /** Unique scorer name, e.g. "decision_quality". */
  name: string;
  /** Evaluate a set of tool calls against the behavioral spec. */
  score(input: ScorerInput, spec: BehaviorSpec): ScorerResult;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Default pass/fail threshold for scorers. */
export const DEFAULT_THRESHOLD = 0.8;

/**
 * Aggregate check results into a single 0-1 score using weighted severity:
 * - MUST fail = 0, MUST_NOT fail = 0, SHOULD fail = 0.5, any pass = 1.0
 * - Returns the mean of all check scores, rounded to 4 decimal places.
 * - Empty checks array returns 1.0 (vacuous truth).
 */
export function aggregateChecks(checks: CheckResult[]): number {
  if (checks.length === 0) return 1.0;

  const scores = checks.map((check) => {
    if (check.passed) return 1.0;
    switch (check.level) {
      case "MUST":
        return 0;
      case "MUST_NOT":
        return 0;
      case "SHOULD":
        return 0.5;
    }
  });

  const sum = scores.reduce((acc, s) => acc + s, 0);
  const mean = sum / scores.length;
  return Math.round(mean * 10000) / 10000;
}
