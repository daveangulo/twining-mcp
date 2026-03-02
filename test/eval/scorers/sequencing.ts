/**
 * Sequencing scorer: checks that tool calls follow workflow step order.
 *
 * For each workflow in the BehaviorSpec, checks if the scenario's tool calls
 * that match workflow step tools appear in the correct relative order.
 * Not all workflow steps need to be present, but those that ARE present
 * must be in order.
 */
import type { Scorer, ScorerResult, CheckResult } from "../scorer-types.js";
import { aggregateChecks, DEFAULT_THRESHOLD } from "../scorer-types.js";
import type { ScorerInput } from "../scenario-schema.js";
import type { BehaviorSpec, WorkflowScenario } from "../types.js";

/**
 * Check if calls matching a workflow's steps appear in order.
 * Returns null if no matching calls found (workflow not represented).
 */
function checkWorkflowOrder(
  input: ScorerInput,
  workflow: WorkflowScenario,
): CheckResult | null {
  // Extract the ordered tools from the workflow
  const workflowTools = workflow.steps
    .sort((a, b) => a.order - b.order)
    .map((s) => s.tool);

  // Find which workflow tools appear in the call sequence and their indices
  const matchedCalls: { tool: string; index: number; stepOrder: number }[] = [];
  for (const call of input.calls) {
    const stepIdx = workflowTools.indexOf(call.tool);
    if (stepIdx !== -1) {
      matchedCalls.push({
        tool: call.tool,
        index: call.index,
        stepOrder: stepIdx,
      });
    }
  }

  // If fewer than 2 matching calls, ordering is vacuously correct
  if (matchedCalls.length < 2) return null;

  // Check that step orders are non-decreasing in call sequence order
  const sortedByCallOrder = [...matchedCalls].sort(
    (a, b) => a.index - b.index,
  );
  let inOrder = true;
  for (let i = 1; i < sortedByCallOrder.length; i++) {
    const prev = sortedByCallOrder[i - 1]!;
    const curr = sortedByCallOrder[i]!;
    if (curr.stepOrder < prev.stepOrder) {
      inOrder = false;
      break;
    }
  }

  return {
    ruleId: `WF-SEQ-${workflow.name}`,
    level: "SHOULD",
    passed: inOrder,
    message: inOrder
      ? `Workflow "${workflow.name}" steps in correct order`
      : `Workflow "${workflow.name}" steps out of order`,
  };
}

export const sequencingScorer: Scorer = {
  name: "sequencing",
  score(input: ScorerInput, spec: BehaviorSpec): ScorerResult {
    if (input.calls.length === 0) {
      return { scorer: this.name, score: 1, passed: true, checks: [] };
    }

    const checks: CheckResult[] = [];

    for (const workflow of spec.workflows) {
      const result = checkWorkflowOrder(input, workflow);
      if (result) {
        checks.push(result);
      }
    }

    // If no workflows matched, vacuous pass
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
