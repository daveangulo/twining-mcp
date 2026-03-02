/**
 * Regression Baseline Generator
 *
 * Generates a structured regression-baseline.json capturing the complete
 * post-tuning eval state: per-scenario scores, per-scorer thresholds,
 * aggregate pass rates, holdout results, and token budget metrics.
 *
 * Usage: npx tsx test/eval/regression-baseline.ts
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SCORER_THRESHOLDS } from "./scorer-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScenarioScore {
  score: number;
  passed: boolean;
  threshold: number;
  checks_passed: number;
  checks_total: number;
  expected?: boolean;
}

interface EvalScenario {
  name: string;
  category: string;
  scores: Record<string, ScenarioScore>;
}

interface EvalResults {
  timestamp: string;
  threshold?: number;
  summary: {
    total_scenarios: number;
    total_checks: number;
    passed_checks: number;
    overall_score: number;
    effective_pass_rate?: number;
    effective_passed?: number;
    total_pairs?: number;
  };
  scenarios: EvalScenario[];
}

interface ScenarioYaml {
  name: string;
  category: string;
  tags?: string[];
  holdout?: boolean;
}

interface BaselineScenario {
  name: string;
  category: string;
  tags: string[];
  holdout: boolean;
  scores: Record<string, {
    score: number;
    passed: boolean;
    threshold: number;
    checks_passed: number;
    checks_total: number;
  }>;
}

interface RegressionBaseline {
  version: "1.0";
  timestamp: string;
  plugin_version: string;
  thresholds: Record<string, number>;
  token_budget: {
    pre_tuning_bytes: number;
    post_tuning_bytes: number;
    growth_percent: number;
    cap_bytes: number;
  };
  aggregate: {
    synthetic_pass_rate: number;
    synthetic_overall_score: number;
    transcript_pass_rate: number;
    transcript_overall_score: number;
    holdout_pass_rate: number;
    holdout_overall_score: number;
  };
  scenarios: BaselineScenario[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "../..");
const RESULTS_DIR = path.join(ROOT, "test/eval/results");
const SCENARIOS_DIR = path.join(ROOT, "test/eval/scenarios");

const PLUGIN_ARTIFACTS = [
  "plugin/skills/twining-orient/SKILL.md",
  "plugin/skills/twining-decide/SKILL.md",
  "plugin/skills/twining-verify/SKILL.md",
  "plugin/skills/twining-coordinate/SKILL.md",
  "plugin/skills/twining-handoff/SKILL.md",
  "plugin/skills/twining-dispatch/SKILL.md",
  "plugin/skills/twining-map/SKILL.md",
  "plugin/skills/twining-review/SKILL.md",
  "plugin/agents/twining-aware-worker.md",
  "plugin/agents/twining-coordinator.md",
  "plugin/hooks/hooks.json",
  "plugin/hooks/stop-hook.sh",
  "plugin/hooks/subagent-stop-hook.sh",
];

const PRE_TUNING_BYTES = 34838;
const CAP_BYTES = Math.floor(PRE_TUNING_BYTES * 1.2); // 41806

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function readOptionalJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return readJson<T>(filePath);
}

/** Load scenario YAML metadata (tags, holdout flag) keyed by name. */
function loadScenarioMeta(): Map<string, ScenarioYaml> {
  const meta = new Map<string, ScenarioYaml>();
  const files = fs.readdirSync(SCENARIOS_DIR).filter(f => f.endsWith(".yaml"));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf8");
    const doc = yaml.load(raw) as ScenarioYaml;
    if (doc?.name) {
      meta.set(doc.name, doc);
    }
  }
  return meta;
}

/** Measure total bytes of plugin artifacts. */
function measureTokenBudget(): number {
  let total = 0;
  for (const relPath of PLUGIN_ARTIFACTS) {
    const absPath = path.join(ROOT, relPath);
    if (fs.existsSync(absPath)) {
      const stat = fs.statSync(absPath);
      total += stat.size;
    }
  }
  return total;
}

/** Calculate pass rate for a set of eval scenarios using per-scorer thresholds.
 *  For synthetic scenarios with effective_pass_rate (expected negatives handled),
 *  we use that directly. Otherwise compute from scores.
 */
function computePassRate(results: EvalResults): number {
  let totalPairs = 0;
  let passedPairs = 0;

  for (const scenario of results.scenarios) {
    for (const [scorerName, scoreData] of Object.entries(scenario.scores)) {
      totalPairs++;
      const threshold = SCORER_THRESHOLDS[scorerName] ?? 0.8;
      const passed = scoreData.score >= threshold;
      // For scenarios with expected=false, matching the expectation counts as a pass
      if (scoreData.expected === false) {
        if (!passed) passedPairs++; // Expected to fail and did fail = pass
      } else {
        if (passed) passedPairs++; // Expected to pass and did pass = pass
      }
    }
  }

  return totalPairs > 0 ? passedPairs / totalPairs : 0;
}

/** Calculate simple pass rate (score >= threshold) without expected negatives logic. */
function computeSimplePassRate(results: EvalResults): number {
  let totalPairs = 0;
  let passedPairs = 0;

  for (const scenario of results.scenarios) {
    for (const [scorerName, scoreData] of Object.entries(scenario.scores)) {
      totalPairs++;
      const threshold = SCORER_THRESHOLDS[scorerName] ?? 0.8;
      if (scoreData.score >= threshold) passedPairs++;
    }
  }

  return totalPairs > 0 ? passedPairs / totalPairs : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function generateBaseline(): RegressionBaseline {
  // 1. Read eval results
  const synthetic = readJson<EvalResults>(path.join(RESULTS_DIR, "latest.json"));
  const holdout = readOptionalJson<EvalResults>(path.join(RESULTS_DIR, "holdout-latest.json"));
  const transcript = readOptionalJson<EvalResults>(path.join(RESULTS_DIR, "transcript-latest.json"));

  // 2. Read plugin version
  const pluginJson = readJson<{ version: string }>(
    path.join(ROOT, "plugin/.claude-plugin/plugin.json")
  );

  // 3. Load scenario metadata
  const scenarioMeta = loadScenarioMeta();

  // 4. Measure token budget
  const postTuningBytes = measureTokenBudget();
  const growthPercent = Math.round(((postTuningBytes / PRE_TUNING_BYTES) - 1) * 10000) / 100;

  // 5. Build scenario entries
  const scenarios: BaselineScenario[] = [];

  // Synthetic scenarios
  for (const s of synthetic.scenarios) {
    const meta = scenarioMeta.get(s.name);
    const scores: BaselineScenario["scores"] = {};
    for (const [scorerName, scoreData] of Object.entries(s.scores)) {
      scores[scorerName] = {
        score: scoreData.score,
        passed: scoreData.score >= (SCORER_THRESHOLDS[scorerName] ?? 0.8),
        threshold: SCORER_THRESHOLDS[scorerName] ?? 0.8,
        checks_passed: scoreData.checks_passed,
        checks_total: scoreData.checks_total,
      };
    }
    scenarios.push({
      name: s.name,
      category: s.category,
      tags: meta?.tags ?? [],
      holdout: false,
      scores,
    });
  }

  // Holdout scenarios
  if (holdout) {
    for (const s of holdout.scenarios) {
      const meta = scenarioMeta.get(s.name);
      const scores: BaselineScenario["scores"] = {};
      for (const [scorerName, scoreData] of Object.entries(s.scores)) {
        scores[scorerName] = {
          score: scoreData.score,
          passed: scoreData.score >= (SCORER_THRESHOLDS[scorerName] ?? 0.8),
          threshold: SCORER_THRESHOLDS[scorerName] ?? 0.8,
          checks_passed: scoreData.checks_passed,
          checks_total: scoreData.checks_total,
        };
      }
      scenarios.push({
        name: s.name,
        category: s.category,
        tags: meta?.tags ?? [],
        holdout: true,
        scores,
      });
    }
  }

  // Transcript scenarios (not holdout, tagged as transcript)
  if (transcript) {
    for (const s of transcript.scenarios) {
      const scores: BaselineScenario["scores"] = {};
      for (const [scorerName, scoreData] of Object.entries(s.scores)) {
        scores[scorerName] = {
          score: scoreData.score,
          passed: scoreData.score >= (SCORER_THRESHOLDS[scorerName] ?? 0.8),
          threshold: SCORER_THRESHOLDS[scorerName] ?? 0.8,
          checks_passed: scoreData.checks_passed,
          checks_total: scoreData.checks_total,
        };
      }
      scenarios.push({
        name: s.name,
        category: s.category,
        tags: ["transcript"],
        holdout: false,
        scores,
      });
    }
  }

  // 6. Compute aggregate pass rates
  const syntheticPassRate = synthetic.summary.effective_pass_rate ?? computePassRate(synthetic);
  const syntheticOverallScore = synthetic.summary.overall_score;

  const holdoutPassRate = holdout ? computeSimplePassRate(holdout) : 0;
  const holdoutOverallScore = holdout?.summary.overall_score ?? 0;

  // Transcript uses 0.6 threshold per decision, compute average score as pass rate proxy
  const transcriptPassRate = transcript ? computeTranscriptPassRate(transcript) : 0;
  const transcriptOverallScore = transcript?.summary.overall_score ?? 0;

  // 7. Assemble baseline
  const baseline: RegressionBaseline = {
    version: "1.0",
    timestamp: new Date().toISOString(),
    plugin_version: pluginJson.version,
    thresholds: { ...SCORER_THRESHOLDS },
    token_budget: {
      pre_tuning_bytes: PRE_TUNING_BYTES,
      post_tuning_bytes: postTuningBytes,
      growth_percent: growthPercent,
      cap_bytes: CAP_BYTES,
    },
    aggregate: {
      synthetic_pass_rate: Math.round(syntheticPassRate * 10000) / 10000,
      synthetic_overall_score: Math.round(syntheticOverallScore * 10000) / 10000,
      transcript_pass_rate: Math.round(transcriptPassRate * 10000) / 10000,
      transcript_overall_score: Math.round(transcriptOverallScore * 10000) / 10000,
      holdout_pass_rate: Math.round(holdoutPassRate * 10000) / 10000,
      holdout_overall_score: Math.round(holdoutOverallScore * 10000) / 10000,
    },
    scenarios,
  };

  return baseline;
}

/** Compute transcript pass rate using 0.6 threshold (per decision). */
function computeTranscriptPassRate(results: EvalResults): number {
  const threshold = results.threshold ?? 0.6;
  let totalPairs = 0;
  let passedPairs = 0;

  for (const scenario of results.scenarios) {
    // For transcript, use average across all scorers per scenario
    const scores = Object.values(scenario.scores);
    const avgScore = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    totalPairs++;
    if (avgScore >= threshold) passedPairs++;
  }

  return totalPairs > 0 ? passedPairs / totalPairs : 0;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const baseline = generateBaseline();

// Write to file
const outputPath = path.join(RESULTS_DIR, "regression-baseline.json");
fs.writeFileSync(outputPath, JSON.stringify(baseline, null, 2) + "\n");

// Print summary
console.log("Regression Baseline Generated");
console.log("=============================");
console.log(`Version:     ${baseline.version}`);
console.log(`Plugin:      ${baseline.plugin_version}`);
console.log(`Timestamp:   ${baseline.timestamp}`);
console.log(`Scenarios:   ${baseline.scenarios.length}`);
console.log("");
console.log("Aggregate Metrics:");
console.log(`  Synthetic pass rate:   ${(baseline.aggregate.synthetic_pass_rate * 100).toFixed(1)}% (target: 95%)`);
console.log(`  Synthetic score:       ${(baseline.aggregate.synthetic_overall_score * 100).toFixed(1)}%`);
console.log(`  Holdout pass rate:     ${(baseline.aggregate.holdout_pass_rate * 100).toFixed(1)}%`);
console.log(`  Holdout score:         ${(baseline.aggregate.holdout_overall_score * 100).toFixed(1)}%`);
console.log(`  Transcript pass rate:  ${(baseline.aggregate.transcript_pass_rate * 100).toFixed(1)}% (target: 80%)`);
console.log(`  Transcript score:      ${(baseline.aggregate.transcript_overall_score * 100).toFixed(1)}%`);
console.log("");
console.log("Token Budget:");
console.log(`  Pre-tuning:  ${baseline.token_budget.pre_tuning_bytes} bytes`);
console.log(`  Post-tuning: ${baseline.token_budget.post_tuning_bytes} bytes`);
console.log(`  Growth:      ${baseline.token_budget.growth_percent >= 0 ? "+" : ""}${baseline.token_budget.growth_percent}% (cap: 20%)`);
console.log(`  Cap:         ${baseline.token_budget.cap_bytes} bytes`);
console.log(`  Headroom:    ${baseline.token_budget.cap_bytes - baseline.token_budget.post_tuning_bytes} bytes`);
console.log("");
console.log("Thresholds:");
for (const [scorer, threshold] of Object.entries(baseline.thresholds)) {
  console.log(`  ${scorer}: ${threshold}`);
}
console.log("");
console.log(`Baseline written to: ${outputPath}`);
