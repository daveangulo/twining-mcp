/**
 * Transcript eval runner: loads manifest fixtures, parses them with the
 * transcript analyzer, and scores with all 7 deterministic scorers.
 *
 * This is the main entry point for `npm run eval:transcript`. It:
 * 1. Reads test/eval/transcript-manifest.json to discover fixtures
 * 2. For each fixture, reads the JSONL file and calls parseTranscript()
 * 3. For each segment x scorer combination, runs the scorer
 * 4. Uses a lower threshold (0.6) for transcript pass/fail vs synthetic (0.8)
 * 5. Writes accumulated results to test/eval/results/transcript-latest.json
 *
 * Same 7 scorers as eval-runner.eval.ts — proving EVAL-05 (scorer reuse
 * across synthetic scenarios and real transcripts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseTranscript } from "./transcript-analyzer.js";
import { allScorers } from "./scorers/index.js";
import { parseBehaviors } from "./behaviors-parser.js";
import type { BehaviorSpec } from "./types.js";
import type { ScorerResult } from "./scorer-types.js";

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

interface TranscriptFixture {
  file: string;
  description: string;
  expectedQuality: "good" | "poor" | "mixed";
  tags: string[];
}

interface TranscriptManifest {
  fixtures: TranscriptFixture[];
  thresholds?: { default: number };
}

// ---------------------------------------------------------------------------
// Load manifest at collection time
// ---------------------------------------------------------------------------

const manifestPath = path.resolve(
  import.meta.dirname!,
  "transcript-manifest.json",
);
const manifest: TranscriptManifest = JSON.parse(
  fs.readFileSync(manifestPath, "utf-8"),
);
const threshold = manifest.thresholds?.default ?? 0.6;

// ---------------------------------------------------------------------------
// Results accumulator
// ---------------------------------------------------------------------------

interface FixtureResults {
  fixture: string;
  expectedQuality: string;
  segments: SegmentResults[];
}

interface SegmentResults {
  segment: string;
  callCount: number;
  results: ScorerResult[];
}

const accumulated: FixtureResults[] = [];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("transcript eval suite", () => {
  let spec: BehaviorSpec;

  beforeAll(() => {
    const behaviorsPath = path.resolve(
      import.meta.dirname!,
      "../../plugin/BEHAVIORS.md",
    );
    const markdown = fs.readFileSync(behaviorsPath, "utf-8");
    spec = parseBehaviors(markdown);
  });

  for (const fixture of manifest.fixtures) {
    describe(fixture.file, () => {
      // Load and parse the JSONL fixture
      const fixturePath = path.resolve(import.meta.dirname!, fixture.file);
      const jsonlContent = fs.readFileSync(fixturePath, "utf-8");
      const parseResult = parseTranscript(jsonlContent);

      // Track fixture results
      const fixtureResult: FixtureResults = {
        fixture: fixture.file,
        expectedQuality: fixture.expectedQuality,
        segments: [],
      };
      accumulated.push(fixtureResult);

      for (let segIdx = 0; segIdx < parseResult.segments.length; segIdx++) {
        const segment = parseResult.segments[segIdx]!;
        const segmentLabel = `segment ${segIdx} (${segment.calls.length} calls)`;

        // Track segment results
        const segmentResult: SegmentResults = {
          segment: segmentLabel,
          callCount: segment.calls.length,
          results: [],
        };
        fixtureResult.segments.push(segmentResult);

        describe(segmentLabel, () => {
          for (const scorer of allScorers) {
            it(scorer.name, () => {
              const result = scorer.score(segment, spec);

              // Accumulate result (individual scorer tests always pass --
              // per-scorer threshold enforcement on real transcripts is too
              // strict; we assert on average score per fixture instead)
              segmentResult.results.push(result);
            });
          }
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Aggregate assertions: good fixtures should score higher than poor on avg
  // -------------------------------------------------------------------------

  it("good-quality fixtures score >= threshold on average", () => {
    const goodFixtures = accumulated.filter(
      (f) => f.expectedQuality === "good",
    );
    for (const fix of goodFixtures) {
      const allSegScores = fix.segments.flatMap((seg) =>
        seg.results.map((r) => r.score),
      );
      if (allSegScores.length === 0) continue;
      const avg =
        allSegScores.reduce((a, b) => a + b, 0) / allSegScores.length;
      expect(
        avg,
        `Good fixture "${fix.fixture}" average score ${avg.toFixed(4)} should be >= ${threshold}`,
      ).toBeGreaterThanOrEqual(threshold);
    }
  });

  it("good-quality fixtures score higher than poor-quality fixtures on average", () => {
    const avgByQuality = (quality: string): number => {
      const fixes = accumulated.filter((f) => f.expectedQuality === quality);
      const scores = fixes.flatMap((f) =>
        f.segments.flatMap((seg) => seg.results.map((r) => r.score)),
      );
      return scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;
    };

    const goodAvg = avgByQuality("good");
    const poorAvg = avgByQuality("poor");
    expect(
      goodAvg,
      `Good avg (${goodAvg.toFixed(4)}) should be > poor avg (${poorAvg.toFixed(4)})`,
    ).toBeGreaterThan(poorAvg);
  });

  afterAll(() => {
    // Build results JSON in same format as eval-runner.eval.ts
    const scenarioResults = accumulated.flatMap((fix) =>
      fix.segments.map((seg) => {
        const scores: Record<
          string,
          {
            score: number;
            passed: boolean;
            checks_passed: number;
            checks_total: number;
          }
        > = {};

        for (const r of seg.results) {
          scores[r.scorer] = {
            score: r.score,
            passed: r.passed,
            checks_passed: r.checks.filter((c) => c.passed).length,
            checks_total: r.checks.length,
          };
        }

        return {
          name: `${fix.fixture} / ${seg.segment}`,
          category: fix.expectedQuality,
          scores,
        };
      }),
    );

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
      threshold,
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
    const resultsPath = path.resolve(resultsDir, "transcript-latest.json");
    fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  });
});
