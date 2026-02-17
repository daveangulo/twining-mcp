---
phase: 04-git-commit-linking
plan: 02
subsystem: decisions
tags: [git, commit-linking, traceability, decisions, query-tools]

# Dependency graph
requires:
  - phase: 04-git-commit-linking
    plan: 01
    provides: "DecisionEngine.getByCommitHash(), commit_hashes field, linkCommit()"
provides:
  - "commit_hashes in twining_why output for each decision"
  - "twining_commits MCP tool for commit-to-decision lookup"
  - "Bidirectional traceability: decisions reference commits AND commits queryable for decisions"
affects: [05-gsd-bridge]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Backward-compatible field addition with ?? [] fallback for pre-existing decisions"

key-files:
  created: []
  modified:
    - src/engine/decisions.ts
    - src/tools/decision-tools.ts
    - test/decision-engine.test.ts

key-decisions:
  - "Used ?? [] fallback in why() mapping to handle pre-existing decisions without commit_hashes"
  - "Placed twining_commits registration before twining_link_commit for logical grouping (query before mutation)"

patterns-established:
  - "Enriching existing tool output with new fields using null-coalescing fallback"

requirements-completed: [GITL-03, GITL-04]

# Metrics
duration: 2min
completed: 2026-02-17
---

# Phase 4 Plan 2: Commit Query Tools Summary

**twining_why enriched with commit_hashes per decision and twining_commits tool for commit-to-decision reverse lookup**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-17T03:01:20Z
- **Completed:** 2026-02-17T03:03:20Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments
- Added commit_hashes: string[] to twining_why output for every decision in the response
- Registered twining_commits MCP tool enabling commit hash to decision reverse lookup
- Backward-compatible: pre-existing decisions without commit_hashes gracefully return empty array
- 4 new tests covering why() with/without commit hashes, metadata shape, and multi-decision hash queries
- Full suite passes (239 tests, 16 files, zero regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1: Enrich twining_why output with commit hashes and add twining_commits tool** - `61c35b9` (feat)

## Files Created/Modified
- `src/engine/decisions.ts` - Added commit_hashes to why() return type and mapping with ?? [] fallback
- `src/tools/decision-tools.ts` - Registered twining_commits tool with commit_hash input schema
- `test/decision-engine.test.ts` - 4 new tests for commit_hashes in why() and getByCommitHash metadata/multi-decision

## Decisions Made
- Used `?? []` null-coalescing fallback in why() mapping to ensure backward compatibility with decisions created before the commit_hashes feature was added
- Placed twining_commits tool registration before twining_link_commit for logical ordering (query tool before mutation tool)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 4 (Git Commit Linking) now fully complete
- Bidirectional traceability achieved: decisions reference commits via commit_hashes, commits queryable for decisions via twining_commits
- Ready for Phase 5 (GSD Bridge) which builds on the decision engine capabilities

---
*Phase: 04-git-commit-linking*
*Completed: 2026-02-17*
