/**
 * Scorer registry: exports all 7 category scorers.
 */
import type { Scorer } from "../scorer-types.js";
import { sequencingScorer } from "./sequencing.js";
import { scopeQualityScorer } from "./scope-quality.js";
import { argumentQualityScorer } from "./argument-quality.js";
import { decisionHygieneScorer } from "./decision-hygiene.js";
import { workflowCompletenessScorer } from "./workflow-completeness.js";
import { antiPatternsScorer } from "./anti-patterns.js";
import { qualityCriteriaScorer } from "./quality-criteria.js";

export const allScorers: Scorer[] = [
  sequencingScorer,
  scopeQualityScorer,
  argumentQualityScorer,
  decisionHygieneScorer,
  workflowCompletenessScorer,
  antiPatternsScorer,
  qualityCriteriaScorer,
];

export {
  sequencingScorer,
  scopeQualityScorer,
  argumentQualityScorer,
  decisionHygieneScorer,
  workflowCompletenessScorer,
  antiPatternsScorer,
  qualityCriteriaScorer,
};
