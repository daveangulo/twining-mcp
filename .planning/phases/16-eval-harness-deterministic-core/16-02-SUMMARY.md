---
phase: 16-eval-harness-deterministic-core
plan: 02
subsystem: testing
tags: [eval, scorer, deterministic, tdd, vitest]

# Dependency graph
requires:
  - phase: 16-eval-harness-deterministic-core
    provides: Scorer interface, CheckResult, ScorerResult, aggregateChecks, ScorerInput, BehaviorSpec types
  - phase: 15-behavioral-specification
    provides: BehaviorSpec types, parseBehaviors, BEHAVIORS.md
provides:
  - 7 deterministic category scorers implementing the Scorer interface
  - Scorer registry (allScorers) exporting all 7 scorers
  - Comprehensive unit tests with synthetic ScorerInput fixtures
affects: [16-03-eval-runner]

# Tech tracking
tech-stack:
  added: []
  patterns: [TDD red-green for scorer implementations, anti-pattern checker map pattern, criterion checker map pattern]

key-files:
  created:
    - test/eval/scorers/sequencing.ts
    - test/eval/scorers/scope-quality.ts
    - test/eval/scorers/argument-quality.ts
    - test/eval/scorers/decision-hygiene.ts
    - test/eval/scorers/workflow-completeness.ts
    - test/eval/scorers/anti-patterns.ts
    - test/eval/scorers/quality-criteria.ts
    - test/eval/scorers/index.ts
    - test/eval/scorers/scorers.test.ts
  modified: []

key-decisions:
  - "Anti-pattern checkers as named map keyed by anti-pattern ID from BehaviorSpec -- extensible without code changes when new anti-patterns added to BEHAVIORS.md"
  - "Quality criterion checkers as named map keyed by criterion name from BehaviorSpec -- same extensibility pattern"
  - "Workflow sequencing checks only between calls that match workflow steps (partial matching) -- not requiring all steps present"
  - "Scope inflation detection uses simple set membership (project, ., /, empty) -- fast and deterministic"

patterns-established:
  - "Scorer files follow uniform structure: imports, helper functions, exported const implementing Scorer interface"
  - "Check logic inline in scorer, BehaviorSpec referenced for metadata (rule IDs, anti-pattern IDs, criterion names)"
  - "Checker map pattern for extensible category-keyed logic (anti-patterns, quality-criteria)"

requirements-completed: [EVAL-02]

# Metrics
duration: 5min
completed: 2026-03-02
---

# Phase 16 Plan 02: Category Scorers Summary

**7 deterministic category scorers with rule ID traceability, weighted severity aggregation, and 39 unit tests against synthetic fixtures**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-02T15:22:45Z
- **Completed:** 2026-03-02T15:27:28Z
- **Tasks:** 1 (TDD red-green)
- **Files created:** 9

## Accomplishments
- 7 category scorers all implement the Scorer interface with structured CheckResult entries tracing rule IDs to BEHAVIORS.md
- Anti-patterns scorer checks all 5 anti-patterns from BehaviorSpec (fire-and-forget, scope-inflation, rationale-poverty, blind-decisions, blackboard-spam)
- Quality criteria scorer checks all 4 criteria (scope-precision, rationale-quality, parameter-content, alternative-depth)
- 39 new tests added, all 700 project tests pass
- allScorers registry exports all 7 scorers as an array

## Task Commits

Each task was committed atomically (TDD: test then feat):

1. **Task 1: Implement 7 category scorers with unit tests**
   - `8fa8514` (test) - Failing tests for all 7 scorers with synthetic fixtures
   - `d8588c9` (feat) - Implement all 7 scorers with full check logic

## Files Created/Modified
- `test/eval/scorers/sequencing.ts` - Workflow step ordering checks against BehaviorSpec workflows
- `test/eval/scorers/scope-quality.ts` - Scope argument specificity checks (broad scope detection)
- `test/eval/scorers/argument-quality.ts` - Parameter content quality checks (DECIDE-01, DECIDE-02, POST-04, ENTITY-01)
- `test/eval/scorers/decision-hygiene.ts` - Decision workflow pattern checks (ASSEMBLE-01, link-commit follow-up, alternatives)
- `test/eval/scorers/workflow-completeness.ts` - Full workflow coverage checks (step presence ratio)
- `test/eval/scorers/anti-patterns.ts` - Anti-pattern detection via checker map keyed by BehaviorSpec anti-pattern IDs
- `test/eval/scorers/quality-criteria.ts` - Quality criteria compliance via criterion checker map
- `test/eval/scorers/index.ts` - Scorer registry exporting allScorers array and individual named exports
- `test/eval/scorers/scorers.test.ts` - 39 unit tests with 5 synthetic fixtures (happyOrient, happyDecide, badDecide, broadScope, emptySequence)

## Decisions Made
- Anti-pattern and quality-criteria scorers use named checker maps keyed by BehaviorSpec IDs -- adding new anti-patterns or criteria to BEHAVIORS.md only requires adding a new checker function
- Workflow sequencing uses partial matching (only tools present in the call sequence are checked for order) rather than requiring all workflow steps
- Scope inflation detection uses a simple set of known-bad values rather than complex heuristics
- Workflow completeness uses 50% step presence threshold -- workflows with at least half their steps present pass

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All 7 scorers ready for Plan 03 (eval runner) to wire into scenario execution
- allScorers registry provides single import point for the eval runner
- Scorers are fully decoupled from scenario format -- take ScorerInput + BehaviorSpec

## Self-Check: PASSED

All 9 created files verified on disk. Both task commits verified in git history.

---
*Phase: 16-eval-harness-deterministic-core*
*Completed: 2026-03-02*
