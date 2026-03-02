/**
 * Eval test runner: loads all YAML scenarios and runs every scorer against each.
 *
 * This is the main entry point for `npm run eval:synthetic`. It:
 * 1. Loads all scenario YAML files from test/eval/scenarios/ (excluding holdout)
 * 2. Parses plugin/BEHAVIORS.md into a BehaviorSpec
 * 3. For each scenario x scorer combination, runs the scorer
 * 4. Asserts against expected_scores when declared (using per-scorer thresholds)
 * 5. Writes accumulated results to test/eval/results/latest.json
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
// Load scenarios at collection time (before describe blocks run)
// Exclude holdout scenarios from the main eval suite
// ---------------------------------------------------------------------------
const scenarios = loadScenarios({ holdout: false });

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
describe("eval suite", () => {
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

          // Store overridden result for accumulation
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
              `Scenario "${scenario.name}" scorer "${scorer.name}": expected passed=${expected}, got passed=${passed} (score=${result.score}, threshold=${threshold})`,
            ).toBe(expected);
          }
        });
      }
    });
  }

  afterAll(() => {
    // Build expected_scores lookup from loaded scenarios
    const expectedScoresMap = new Map<string, Record<string, boolean>>();
    for (const scenario of scenarios) {
      expectedScoresMap.set(scenario.name, scenario.expected_scores);
    }

    // Build results JSON
    const scenarioResults = Array.from(accumulated.values()).map((entry) => {
      const expectedScores = expectedScoresMap.get(entry.scenario) ?? {};
      const scores: Record<
        string,
        {
          score: number;
          passed: boolean;
          threshold: number;
          checks_passed: number;
          checks_total: number;
          expected?: boolean;
        }
      > = {};
      for (const r of entry.results) {
        const expected = expectedScores[r.scorer];
        scores[r.scorer] = {
          score: r.score,
          passed: r.passed,
          threshold: getThreshold(r.scorer),
          checks_passed: r.checks.filter((c) => c.passed).length,
          checks_total: r.checks.length,
          ...(expected !== undefined ? { expected } : {}),
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

    // Effective pass rate: counts expected negatives (expected=false, passed=false) as effective passes
    const effectivePassed = allResults.filter((r) => {
      if (r.passed) return true;
      // Expected negative: scenario declared expected=false and score correctly failed
      if (r.expected === false && !r.passed) return true;
      return false;
    }).length;

    const output = {
      timestamp: new Date().toISOString(),
      summary: {
        total_scenarios: scenarioResults.length,
        total_checks: totalChecks,
        passed_checks: passedChecks,
        overall_score: overallScore,
        effective_pass_rate:
          allResults.length > 0
            ? Math.round((effectivePassed / allResults.length) * 10000) / 10000
            : 0,
        effective_passed: effectivePassed,
        total_pairs: allResults.length,
      },
      scenarios: scenarioResults,
    };

    // Write results
    const resultsDir = path.resolve(import.meta.dirname!, "results");
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    const resultsPath = path.resolve(resultsDir, "latest.json");
    fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  });
});
