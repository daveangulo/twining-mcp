---
phase: 15-behavioral-specification
plan: 02
subsystem: testing
tags: [behavioral-spec, eval, parser, state-machine, markdown, vitest]

requires:
  - phase: 15-behavioral-specification
    provides: plugin/BEHAVIORS.md (behavioral spec), test/eval/types.ts (type contract)
provides:
  - test/eval/behaviors-parser.ts -- parseBehaviors() state machine parser for BEHAVIORS.md
  - test/eval/behaviors-parser.test.ts -- 18-test validation suite against real BEHAVIORS.md
affects: [phase-16-eval-harness, phase-19-plugin-tuning]

tech-stack:
  added: []
  patterns: [line-by-line-state-machine-parser, format-specific-markdown-extraction, tdd-red-green]

key-files:
  created:
    - test/eval/behaviors-parser.ts
    - test/eval/behaviors-parser.test.ts
  modified: []

key-decisions:
  - "State machine parser with section/subsection tracking rather than markdown AST library"
  - "Parser reads real BEHAVIORS.md in tests, no fixtures -- single source of truth"
  - "Helper functions (parseMarkdownTable, extractCodeBlock, collectProse) for reusable parsing primitives"

patterns-established:
  - "Format-specific markdown extraction: controlled documents parsed by state machine, not AST"
  - "Test against real file: eval tests use actual BEHAVIORS.md, not synthetic fixtures"

requirements-completed: [SPEC-06]

duration: 3min
completed: 2026-03-02
---

# Phase 15 Plan 02: Behaviors Parser Summary

**State machine parser extracting all 32 tool behaviors, 10 workflows, 5 anti-patterns, and 4 quality criteria from BEHAVIORS.md into Zod-validated BehaviorSpec objects**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-02T13:19:02Z
- **Completed:** 2026-03-02T13:21:48Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files created:** 2

## Accomplishments
- Built a line-by-line state machine parser (429 lines) that extracts all structured content from plugin/BEHAVIORS.md into typed BehaviorSpec objects
- Parser correctly extracts: 32 tool behaviors (10 Tier 1 with full usage examples, 22 Tier 2), 10 workflow scenarios, 5 anti-patterns, 4 quality criteria
- 18 test cases validate parser output against the real BEHAVIORS.md file, including Zod schema validation
- All tests pass first try -- no debugging cycles needed
- Full test suite (632 tests across 49 files) passes with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Failing test suite** - `5a3af6b` (test)
2. **Task 1 (GREEN): Parser implementation** - `21f70e5` (feat)

_TDD task: tests written first (RED), then implementation (GREEN). No refactor needed._

## Files Created/Modified
- `test/eval/behaviors-parser.ts` - State machine parser: parseBehaviors(markdown) -> BehaviorSpec with helpers for tables, code blocks, and prose extraction
- `test/eval/behaviors-parser.test.ts` - 18 test cases validating parser against real BEHAVIORS.md: structure, 32 tools, tiers, rules, MUST count, workflows, anti-patterns, quality criteria, Zod validation

## Decisions Made
- Used a state machine with section + subsection tracking rather than regex-per-section approach -- cleaner handling of nested tool sub-sections (context, rules, correct/incorrect usage)
- Tests read the actual plugin/BEHAVIORS.md file, not fixtures -- ensures parser stays in sync with the spec as it evolves
- Three helper functions (parseMarkdownTable, extractCodeBlock, collectProse) extracted for reuse and clarity

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- parseBehaviors() is ready for Phase 16 eval harness to import and use
- BehaviorSpec objects are Zod-validated, ensuring type safety at runtime
- Parser + types + BEHAVIORS.md form the complete pipeline from human-readable spec to machine-consumable eval data

## Self-Check: PASSED

- Files: test/eval/behaviors-parser.ts FOUND, test/eval/behaviors-parser.test.ts FOUND
- Commits: 5a3af6b FOUND, 21f70e5 FOUND
- Parser lines: 429 (min 100)
- Test lines: 177 (min 80)
- Tests: 18/18 passing
- Full suite: 632/632 passing (49 files)

---
*Phase: 15-behavioral-specification*
*Completed: 2026-03-02*
