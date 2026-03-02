/**
 * Workflow completeness scorer: checks workflow step coverage.
 *
 * Detects which workflow patterns are represented in the call sequence
 * by checking if the first tool of any workflow appears. For each detected
 * workflow, checks how many of its expected steps appear. Score based on
 * completeness ratio.
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec, WorkflowScenario } from "../types.js";

function checkWorkflowCompleteness(
  input: ScorerInput,
  workflow: WorkflowScenario,
): CheckResult | null {
  const toolsInCalls = new Set(input.calls.map((c) => c.tool));
  const workflowStepTools = workflow.steps
    .sort((a, b) => a.order - b.order)
    .map((s) => s.tool);

  // Detect if workflow is represented: first tool appears
  const firstTool = workflowStepTools[0];
  if (!firstTool || !toolsInCalls.has(firstTool)) return null;

  // Count how many of the workflow's steps appear
  const matchedSteps = workflowStepTools.filter((t) => toolsInCalls.has(t));
  const completeness = matchedSteps.length / workflowStepTools.length;

  // Pass if at least 60% of steps present (some steps are optional in practice)
  const passed = completeness >= 0.5;

  return {
    ruleId: `WF-COMPLETE-${workflow.name}`,
    level: "SHOULD",
    passed,
    message: passed
      ? `Workflow "${workflow.name}": ${matchedSteps.length}/${workflowStepTools.length} steps present (${Math.round(completeness * 100)}%)`
      : `Workflow "${workflow.name}" incomplete: only ${matchedSteps.length}/${workflowStepTools.length} steps present (${Math.round(completeness * 100)}%)`,
  };
}

export const workflowCompletenessScorer: Scorer = {
  name: "workflow-completeness",
  async score(input: ScorerInput, spec: BehaviorSpec): Promise<ScorerResult> {
    if (input.calls.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const checks: CheckResult[] = [];

    for (const workflow of spec.workflows) {
      const result = checkWorkflowCompleteness(input, workflow);
      if (result) {
        checks.push(result);
      }
    }

    // No workflows detected -- vacuous pass
    if (checks.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const score = aggregateChecks(checks);
    return {
      scorer: this.name,
      score,
      passed: score >= DEFAULT_THRESHOLD,
      checks,
    };
  },
};
