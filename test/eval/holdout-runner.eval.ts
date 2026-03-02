/**
 * Holdout eval runner: loads only holdout YAML scenarios and runs every scorer.
 *
 * This is a separate runner for `npm run eval:holdout`. It mirrors the main
 * eval-runner but only loads scenarios with `holdout: true`. Results are written
 * to test/eval/results/holdout-latest.json.
 *
 * Holdout scenarios validate generalization -- they are never used for tuning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadScenarios } from "./scenario-loader.js";
import { normalizeScenario } from "./scenario-schema.js";
import { allScorers } from "./scorers/index.js";
import { parseBehaviors } from "./behaviors-parser.js";
import type { BehaviorSpec } from "./types.js";
import type { ScorerResult } from "./scorer-types.js";
import { getThreshold } from "./scorer-types.js";

// ---------------------------------------------------------------------------
// Load holdout scenarios only
// ---------------------------------------------------------------------------
const scenarios = loadScenarios({ holdout: true });

// ---------------------------------------------------------------------------
// Results accumulator
// ---------------------------------------------------------------------------
interface ScenarioResults {
  scenario: string;
  category: string;
  results: ScorerResult[];
}

const accumulated: Map<string, ScenarioResults> = new Map();

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("holdout eval suite", () => {
  let spec: BehaviorSpec;

  beforeAll(() => {
    const behaviorsPath = path.resolve(
      import.meta.dirname!,
      "../../plugin/BEHAVIORS.md",
    );
    const markdown = fs.readFileSync(behaviorsPath, "utf-8");
    spec = parseBehaviors(markdown);
  });

  for (const scenario of scenarios) {
    describe(scenario.name, () => {
      for (const scorer of allScorers) {
        it(`${scorer.name}`, async () => {
          const input = normalizeScenario(scenario);
          const result = await scorer.score(input, spec);

          // Override passed with per-scorer threshold
          const threshold = getThreshold(scorer.name);
          const passed = result.score >= threshold;

          const adjustedResult: ScorerResult = { ...result, passed };

          // Accumulate result
          if (!accumulated.has(scenario.name)) {
            accumulated.set(scenario.name, {
              scenario: scenario.name,
              category: scenario.category,
              results: [],
            });
          }
          accumulated.get(scenario.name)!.results.push(adjustedResult);

          // Assert against expected_scores if declared for this scorer
          const expected = scenario.expected_scores[scorer.name];
          if (expected !== undefined) {
            expect(
              passed,
              `Holdout "${scenario.name}" scorer "${scorer.name}": expected passed=${expected}, got passed=${passed} (score=${result.score}, threshold=${threshold})`,
            ).toBe(expected);
          }
        });
      }
    });
  }

  afterAll(() => {
    // Build results JSON
    const scenarioResults = Array.from(accumulated.values()).map((entry) => {
      const scores: Record<
        string,
        {
          score: number;
          passed: boolean;
          threshold: number;
          checks_passed: number;
          checks_total: number;
        }
      > = {};
      for (const r of entry.results) {
        scores[r.scorer] = {
          score: r.score,
          passed: r.passed,
          threshold: getThreshold(r.scorer),
          checks_passed: r.checks.filter((c) => c.passed).length,
          checks_total: r.checks.length,
        };
      }
      return {
        name: entry.scenario,
        category: entry.category,
        scores,
      };
    });

    const allResults = scenarioResults.flatMap((s) =>
      Object.values(s.scores),
    );
    const totalChecks = allResults.reduce(
      (sum, r) => sum + r.checks_total,
      0,
    );
    const passedChecks = allResults.reduce(
      (sum, r) => sum + r.checks_passed,
      0,
    );
    const allScores = allResults.map((r) => r.score);
    const overallScore =
      allScores.length > 0
        ? Math.round(
            (allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10000,
          ) / 10000
        : 0;

    const output = {
      timestamp: new Date().toISOString(),
      summary: {
        total_scenarios: scenarioResults.length,
        total_checks: totalChecks,
        passed_checks: passedChecks,
        overall_score: overallScore,
      },
      scenarios: scenarioResults,
    };

    // Write results
    const resultsDir = path.resolve(import.meta.dirname!, "results");
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    const resultsPath = path.resolve(resultsDir, "holdout-latest.json");
    fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  });
});
