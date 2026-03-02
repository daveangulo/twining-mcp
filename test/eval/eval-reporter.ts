/**
 * Custom vitest reporter for eval summary output.
 *
 * After all tests complete, reads test/eval/results/latest.json and prints
 * a summary table showing per-category scores, overall pass rate, and
 * worst-performing scenarios.
 */
import fs from "node:fs";
import path from "node:path";
import type { Reporter } from "vitest/reporters";

interface ScenarioScore {
  score: number;
  passed: boolean;
  checks_passed: number;
  checks_total: number;
}

interface ScenarioResult {
  name: string;
  category: string;
  scores: Record<string, ScenarioScore>;
}

interface EvalResults {
  timestamp: string;
  summary: {
    total_scenarios: number;
    total_checks: number;
    passed_checks: number;
    overall_score: number;
  };
  scenarios: ScenarioResult[];
}

function pad(str: string, len: number): string {
  return str.padEnd(len);
}

function padLeft(str: string, len: number): string {
  return str.padStart(len);
}

export default class EvalReporter implements Reporter {
  onTestRunEnd(): void {
    const resultsPath = path.resolve(
      import.meta.dirname!,
      "results/latest.json",
    );

    if (!fs.existsSync(resultsPath)) {
      console.log("\n  No eval results found (first run?).\n");
      return;
    }

    let data: EvalResults;
    try {
      data = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
    } catch {
      console.log("\n  Could not parse eval results.\n");
      return;
    }

    const { summary, scenarios } = data;

    console.log("");
    console.log(
      "  ============================================================",
    );
    console.log("  EVAL SUMMARY");
    console.log(`  Run: ${data.timestamp}`);
    console.log(
      "  ============================================================",
    );
    console.log("");

    // Per-category breakdown
    const categories = new Map<
      string,
      { total: number; passed: number; scores: number[] }
    >();

    for (const scenario of scenarios) {
      const scorerValues = Object.values(scenario.scores);
      const scenarioPassCount = scorerValues.filter((s) => s.passed).length;
      const scenarioScores = scorerValues.map((s) => s.score);

      const cat = categories.get(scenario.category) ?? {
        total: 0,
        passed: 0,
        scores: [],
      };
      cat.total += scorerValues.length;
      cat.passed += scenarioPassCount;
      cat.scores.push(...scenarioScores);
      categories.set(scenario.category, cat);
    }

    // Header
    console.log(
      `  ${pad("Category", 16)} ${padLeft("Tests", 7)} ${padLeft("Pass Rate", 11)} ${padLeft("Avg Score", 11)}`,
    );
    console.log(`  ${"-".repeat(16)} ${"-".repeat(7)} ${"-".repeat(11)} ${"-".repeat(11)}`);

    for (const [cat, stats] of [...categories.entries()].sort()) {
      const passRate =
        stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : "0.0";
      const avgScore =
        stats.scores.length > 0
          ? (
              stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length
            ).toFixed(4)
          : "0.0000";
      console.log(
        `  ${pad(cat, 16)} ${padLeft(String(stats.total), 7)} ${padLeft(passRate + "%", 11)} ${padLeft(avgScore, 11)}`,
      );
    }

    // Overall
    const totalTests = [...categories.values()].reduce(
      (s, c) => s + c.total,
      0,
    );
    const totalPassed = [...categories.values()].reduce(
      (s, c) => s + c.passed,
      0,
    );
    const overallPassRate =
      totalTests > 0
        ? ((totalPassed / totalTests) * 100).toFixed(1)
        : "0.0";
    console.log(`  ${"-".repeat(16)} ${"-".repeat(7)} ${"-".repeat(11)} ${"-".repeat(11)}`);
    console.log(
      `  ${pad("OVERALL", 16)} ${padLeft(String(totalTests), 7)} ${padLeft(overallPassRate + "%", 11)} ${padLeft(String(summary.overall_score), 11)}`,
    );

    console.log("");
    console.log(
      `  Checks: ${summary.passed_checks}/${summary.total_checks} passed`,
    );
    console.log("");

    // Worst performers
    const scenarioAvgs = scenarios.map((s) => {
      const scores = Object.values(s.scores).map((v) => v.score);
      const avg =
        scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : 1;
      return { name: s.name, avg };
    });
    scenarioAvgs.sort((a, b) => a.avg - b.avg);

    const worst = scenarioAvgs.slice(0, 3);
    if (worst.length > 0) {
      console.log("  Worst Performers:");
      for (const w of worst) {
        console.log(`    - ${w.name}: ${w.avg.toFixed(4)}`);
      }
      console.log("");
    }

    console.log(
      "  ============================================================",
    );
    console.log("");
  }
}
