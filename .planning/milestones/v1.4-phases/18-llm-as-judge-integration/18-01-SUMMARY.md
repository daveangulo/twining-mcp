---
phase: 18-llm-as-judge-integration
plan: 01
subsystem: testing
tags: [anthropic-sdk, llm-judge, async-scorer, eval-harness, tool-use]

# Dependency graph
requires:
  - phase: 16-eval-scenarios-scorers
    provides: "7 deterministic scorers with Scorer interface and ScorerResult types"
  - phase: 17-transcript-analysis
    provides: "Transcript eval runner reusing same allScorers array"
provides:
  - "Anthropic SDK wrapper (judge.ts) with structured tool_use and k-trial consensus"
  - "Async Scorer interface (Promise<ScorerResult>) across all scorers"
  - "Conditional scorer registry with TWINING_EVAL_JUDGE env-var gating"
  - "Optional type field on ScorerResult (deterministic | llm)"
affects: [18-02, 19-plugin-tuning]

# Tech tracking
tech-stack:
  added: ["@anthropic-ai/sdk"]
  patterns: ["structured tool_use for LLM evaluation", "k-trial consensus scoring", "env-var gated scorer composition"]

key-files:
  created:
    - "test/eval/judge.ts"
  modified:
    - "test/eval/scorer-types.ts"
    - "test/eval/scorers/index.ts"
    - "test/eval/scorers/sequencing.ts"
    - "test/eval/scorers/scope-quality.ts"
    - "test/eval/scorers/argument-quality.ts"
    - "test/eval/scorers/decision-hygiene.ts"
    - "test/eval/scorers/workflow-completeness.ts"
    - "test/eval/scorers/anti-patterns.ts"
    - "test/eval/scorers/quality-criteria.ts"
    - "test/eval/scorers/scorers.test.ts"
    - "test/eval/eval-runner.eval.ts"
    - "test/eval/transcript-runner.transcript.ts"

key-decisions:
  - "Anthropic SDK as devDependency -- only used in eval, not shipped in production"
  - "createJudgeClient returns null when ANTHROPIC_API_KEY unset -- graceful degradation"
  - "Default judge model claude-haiku-4-5-20250929 overridable via TWINING_EVAL_MODEL"
  - "consensusScore uses majority voting with median fallback for no-majority case"

patterns-established:
  - "Async scorer interface: all scorers return Promise<ScorerResult>, callers await"
  - "Conditional scorer composition: deterministicScorers always, llmScorers only when TWINING_EVAL_JUDGE=1"
  - "Structured tool_use for LLM evaluation: forced tool_choice with judge_result schema"

requirements-completed: [EVAL-06, EVAL-07]

# Metrics
duration: 4min
completed: 2026-03-02
---

# Phase 18 Plan 01: SDK + Async Scorer Foundation Summary

**Anthropic SDK wrapper with structured tool_use consensus scoring, async Scorer interface across all 7 scorers, and conditional TWINING_EVAL_JUDGE registry**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-02T17:41:00Z
- **Completed:** 2026-03-02T17:45:43Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- Created judge.ts with createJudgeClient, callJudge (structured tool_use), consensusScore (k-trial majority voting), and buildRubricPrompt
- Made Scorer.score() async (Promise<ScorerResult>) across all 7 deterministic scorers, both eval runners, and scorer unit tests
- Added conditional scorer registry: deterministicScorers always active, llmScorers gated behind TWINING_EVAL_JUDGE=1
- All 723 main tests, 154 synthetic eval tests, and 16 transcript eval tests pass with zero behavioral changes

## Task Commits

Each task was committed atomically:

1. **Task 1: Install Anthropic SDK and create judge.ts wrapper** - `45daf03` (feat)
2. **Task 2: Make scorer interface async, update registry and both runners** - `a4c8484` (feat)

## Files Created/Modified
- `test/eval/judge.ts` - Anthropic SDK wrapper: createJudgeClient, callJudge, consensusScore, buildRubricPrompt
- `test/eval/scorer-types.ts` - Scorer.score() now returns Promise<ScorerResult>, added optional type field
- `test/eval/scorers/index.ts` - Conditional registry: deterministicScorers, llmScorers, allScorers
- `test/eval/scorers/sequencing.ts` - async score() method
- `test/eval/scorers/scope-quality.ts` - async score() method
- `test/eval/scorers/argument-quality.ts` - async score() method
- `test/eval/scorers/decision-hygiene.ts` - async score() method
- `test/eval/scorers/workflow-completeness.ts` - async score() method
- `test/eval/scorers/anti-patterns.ts` - async score() method
- `test/eval/scorers/quality-criteria.ts` - async score() method
- `test/eval/scorers/scorers.test.ts` - All test callbacks async with await
- `test/eval/eval-runner.eval.ts` - async test callback with await scorer.score()
- `test/eval/transcript-runner.transcript.ts` - async test callback with await scorer.score()
- `package.json` - Added @anthropic-ai/sdk devDependency

## Decisions Made
- Anthropic SDK as devDependency (only used in eval, not shipped in production)
- createJudgeClient returns null when ANTHROPIC_API_KEY unset for graceful degradation
- Default judge model claude-haiku-4-5-20250929 overridable via TWINING_EVAL_MODEL env var
- consensusScore uses majority voting (>= ceil(k/2)) with median fallback

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated scorer unit tests for async interface**
- **Found during:** Task 2 (async scorer interface migration)
- **Issue:** scorers.test.ts had 19 direct scorer.score() calls that needed async/await after the interface change
- **Fix:** Made all test callbacks async and added await to all scorer.score() calls
- **Files modified:** test/eval/scorers/scorers.test.ts
- **Verification:** All 39 scorer unit tests pass (npm test)
- **Committed in:** a4c8484 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary mechanical change missed in plan. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. ANTHROPIC_API_KEY only needed when running LLM scorers (TWINING_EVAL_JUDGE=1).

## Next Phase Readiness
- judge.ts ready for Plan 18-02 to create LLM scorer implementations
- llmScorers array in scorers/index.ts ready to be populated
- All existing tests pass with async interface -- zero regressions

---
*Phase: 18-llm-as-judge-integration*
*Completed: 2026-03-02*
