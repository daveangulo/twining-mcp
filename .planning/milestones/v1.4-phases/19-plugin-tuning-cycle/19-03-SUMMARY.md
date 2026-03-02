---
phase: 19-plugin-tuning-cycle
plan: 03
subsystem: testing
tags: [eval, regression, baseline, token-budget, ci-gates]

requires:
  - phase: 19-01
    provides: "Eval harness with per-scorer thresholds and holdout scenarios"
  - phase: 19-02
    provides: "Tuned scorers with 100% effective pass rate across 154 scenario-scorer pairs"
provides:
  - "regression-baseline.json capturing post-tuning eval state for CI comparison"
  - "Rerunnable baseline generator script (eval:baseline npm command)"
  - "Token budget metrics embedded in baseline"
affects: [ci-pipeline, future-tuning-cycles]

tech-stack:
  added: []
  patterns: ["Regression baseline as structured JSON for CI gates"]

key-files:
  created:
    - test/eval/regression-baseline.ts
    - test/eval/results/regression-baseline.json
  modified:
    - package.json

key-decisions:
  - "Pass rate comparison (not overall score) for holdout gap -- synthetic includes violation scenarios that deliberately score low"
  - "Transcript pass rate uses per-scenario average across scorers with 0.6 threshold"
  - "Token budget measured from plugin artifact files (same set as measure-plugin-tokens.sh)"

patterns-established:
  - "Regression baseline structure: version, thresholds, token_budget, aggregate, scenarios array"
  - "Rerunnable baseline generation via npm run eval:baseline"

requirements-completed: [TUNE-03, TUNE-04]

duration: 5min
completed: 2026-03-02
---

# Phase 19 Plan 03: Regression Baseline Summary

**Structured regression baseline JSON with 30 scenarios, 100% synthetic/transcript pass rates, 97.6% holdout pass rate, and 0% token budget growth**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-02T19:09:10Z
- **Completed:** 2026-03-02T19:14:46Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Generated regression-baseline.json capturing complete post-tuning eval state (30 scenarios across synthetic, holdout, and transcript)
- All targets met: synthetic 100% (target 95%), transcript 100% (target 80%), holdout 97.6% (within 2.4pp of training), token budget 0% growth (cap 20%)
- Rerunnable baseline script with npm run eval:baseline command
- Per-scorer thresholds, per-scenario detail, and token budget metrics all embedded for future CI comparison

## Task Commits

Each task was committed atomically:

1. **Task 1: Regression baseline generator script** - `9f9a38d` (feat)
2. **Task 2: Generate and validate the regression baseline** - `3e208db` (feat)

**Plan metadata:** `62563c2` (docs: complete plan)

## Files Created/Modified
- `test/eval/regression-baseline.ts` - Baseline generator reading all eval results, scenario YAML metadata, plugin version, and token budget
- `test/eval/results/regression-baseline.json` - Generated baseline with 30 scenarios, aggregate metrics, and per-scorer thresholds
- `package.json` - Added eval:baseline npm script

## Decisions Made
- Holdout gap measured by pass rate (2.4pp) rather than overall score (11.3pp) -- overall score comparison is misleading because synthetic includes violation scenarios that deliberately score low while holdout is all happy-path
- Transcript pass rate computed using per-scenario average across all scorers with 0.6 threshold (matching transcript eval config)
- Token budget at 0% growth (pre-tuning baseline was already at target size) -- no plugin skill modifications were needed during the tuning cycle (per 19-02 finding that all failures were scorer false positives)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Regression baseline established for future CI gate implementation (EVAL-13, post-v1.4)
- Phase 19 (Plugin Tuning Cycle) is complete -- all 3 plans executed
- v1.4 milestone ready for completion

## Self-Check: PASSED

- [x] test/eval/regression-baseline.ts exists
- [x] test/eval/results/regression-baseline.json exists
- [x] Commit 9f9a38d exists (Task 1)
- [x] Commit 3e208db exists (Task 2)

---
*Phase: 19-plugin-tuning-cycle*
*Completed: 2026-03-02*
