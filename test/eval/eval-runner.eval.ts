/**
 * Eval test runner: loads all YAML scenarios and runs every scorer against each.
 *
 * This is the main entry point for `npm run eval:synthetic`. It:
 * 1. Loads all scenario YAML files from test/eval/scenarios/
 * 2. Parses plugin/BEHAVIORS.md into a BehaviorSpec
 * 3. For each scenario x scorer combination, runs the scorer
 * 4. Asserts against expected_scores when declared
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

// ---------------------------------------------------------------------------
// Load scenarios at collection time (before describe blocks run)
// ---------------------------------------------------------------------------
const scenarios = loadScenarios();

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

          // Accumulate result
          if (!accumulated.has(scenario.name)) {
            accumulated.set(scenario.name, {
              scenario: scenario.name,
              category: scenario.category,
              results: [],
            });
          }
          accumulated.get(scenario.name)!.results.push(result);

          // Assert against expected_scores if declared for this scorer
          const expected = scenario.expected_scores[scorer.name];
          if (expected !== undefined) {
            expect(
              result.passed,
              `Scenario "${scenario.name}" scorer "${scorer.name}": expected passed=${expected}, got passed=${result.passed} (score=${result.score})`,
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
          checks_passed: number;
          checks_total: number;
        }
      > = {};
      for (const r of entry.results) {
        scores[r.scorer] = {
          score: r.score,
          passed: r.passed,
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
    const resultsPath = path.resolve(resultsDir, "latest.json");
    fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  });
});
