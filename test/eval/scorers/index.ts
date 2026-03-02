/**
 * Scorer registry: exports deterministic scorers and conditional LLM scorers.
 *
 * By default, allScorers contains only the 7 deterministic category scorers.
 * When TWINING_EVAL_JUDGE=1 is set, LLM scorers (added in Plan 18-02) are
 * included as well.
 */
import type { Scorer } from "../scorer-types.js";
import { sequencingScorer } from "./sequencing.js";
import { scopeQualityScorer } from "./scope-quality.js";
import { argumentQualityScorer } from "./argument-quality.js";
import { decisionHygieneScorer } from "./decision-hygiene.js";
import { workflowCompletenessScorer } from "./workflow-completeness.js";
import { antiPatternsScorer } from "./anti-patterns.js";
import { qualityCriteriaScorer } from "./quality-criteria.js";

export const deterministicScorers: Scorer[] = [
  sequencingScorer,
  scopeQualityScorer,
  argumentQualityScorer,
  decisionHygieneScorer,
  workflowCompletenessScorer,
  antiPatternsScorer,
  qualityCriteriaScorer,
];

// LLM scorers loaded conditionally in Plan 18-02
// For now, export the structure with empty llmScorers
export const llmScorers: Scorer[] = [];

export const allScorers: Scorer[] =
  process.env.TWINING_EVAL_JUDGE === "1"
    ? [...deterministicScorers, ...llmScorers]
    : deterministicScorers;

export {
  sequencingScorer,
  scopeQualityScorer,
  argumentQualityScorer,
  decisionHygieneScorer,
  workflowCompletenessScorer,
  antiPatternsScorer,
  qualityCriteriaScorer,
};
