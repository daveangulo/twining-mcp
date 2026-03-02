---
phase: 15-behavioral-specification
plan: 01
subsystem: testing
tags: [behavioral-spec, eval, markdown, zod, typescript]

requires:
  - phase: none
    provides: n/a (first phase of v1.4)
provides:
  - plugin/BEHAVIORS.md -- authoritative behavioral specification for all 32 MCP tools
  - test/eval/types.ts -- TypeScript interfaces and Zod schemas for parsed behavioral spec
affects: [15-02-parser, phase-16-eval-harness, phase-19-plugin-tuning]

tech-stack:
  added: []
  patterns: [structured-markdown-convention, tiered-tool-specification, MUST-rule-budgeting]

key-files:
  created:
    - plugin/BEHAVIORS.md
    - test/eval/types.ts
  modified: []

key-decisions:
  - "10 MUST rules (9 MUST + 1 MUST_NOT) allocated across 6 tools within the 8-12 hard cap"
  - "MUST allocation: DECIDE (3), POST (1), ASSEMBLE (1), HANDOFF (1), VERIFY (1), ENTITY (1), RELATION (1), POST MUST_NOT (1)"
  - "10 workflow scenarios: 8 from existing skills + 2 composites (new-session-lifecycle, conflict-resolution)"
  - "5 anti-patterns cataloged: fire-and-forget-decisions, scope-inflation, rationale-poverty, blackboard-spam, blind-decisions"
  - "4 quality criteria: scope-precision, rationale-quality, parameter-content, alternative-depth"

patterns-established:
  - "Structured markdown convention: ### tool_name + <!-- tier: N --> + #### Context/Rules/Usage sections"
  - "MUST rule budgeting: hard cap prevents over-specification, SHOULD for strong recommendations"
  - "Eval type contract: Zod schemas mirror interfaces for runtime + compile-time validation"

requirements-completed: [SPEC-01, SPEC-02, SPEC-03, SPEC-04, SPEC-05, SPEC-06, QUAL-01, QUAL-02, QUAL-03, QUAL-04]

duration: 6min
completed: 2026-03-02
---

# Phase 15 Plan 01: Behavioral Specification Summary

**Complete behavioral spec (768 lines) covering all 32 MCP tools with 10 MUST rules, 10 workflows, 5 anti-patterns, 4 quality criteria, plus shared Zod/TypeScript eval types**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-02T13:10:03Z
- **Completed:** 2026-03-02T13:16:09Z
- **Tasks:** 2
- **Files created:** 2

## Accomplishments
- Created test/eval/types.ts with 9 TypeScript interfaces and 9 Zod schemas defining the contract between BEHAVIORS.md, the parser (Plan 02), and the eval harness (Phase 16)
- Authored plugin/BEHAVIORS.md with 768 lines covering all 32 tools organized by category, with 10 Tier 1 tools getting full depth (context, rules, correct/incorrect usage) and 22 Tier 2 tools getting lighter coverage
- Stayed within the 8-12 MUST rule hard cap (10 total: 9 MUST + 1 MUST_NOT)
- All parameter names in usage examples cross-referenced against actual Zod schemas in src/tools/*.ts
- 10 workflow scenarios from 8 skill-derived + 2 composite workflows
- 5 anti-patterns with concrete bad/good examples
- 4 quality criteria with good/acceptable/bad levels

## Task Commits

Each task was committed atomically:

1. **Task 1: Define shared eval types** - `a172d62` (feat)
2. **Task 2: Write plugin/BEHAVIORS.md behavioral specification** - `22959eb` (feat)

## Files Created/Modified
- `test/eval/types.ts` - TypeScript interfaces (BehaviorSpec, ToolBehavior, etc.) and Zod schemas for parsed behavioral spec validation
- `plugin/BEHAVIORS.md` - Complete behavioral specification for all 32 MCP tools with tiered coverage, workflows, anti-patterns, and quality criteria

## Decisions Made
- MUST rule allocation: DECIDE gets 3 (rationale, alternatives, use-decide-not-post), POST gets 1 (entry_type accuracy) + 1 MUST_NOT (no decision via post), ASSEMBLE gets 1 (call before decisions), HANDOFF gets 1 (accurate result status), VERIFY gets 1 (run before complete), ENTITY gets 1 (specific names), RELATION gets 1 (entities must exist)
- Added "blind-decisions" as a 5th anti-pattern beyond the 4 required -- emerged naturally from the assembly-before-decision MUST rule
- Added "alternative-depth" as a 4th quality criterion beyond the 3 required -- complements rationale-quality
- twining_status gets Tier 1 despite having no required parameters -- it is the entry point for session orientation

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- plugin/BEHAVIORS.md is ready for the parser (Plan 02: test/eval/behaviors-parser.ts)
- test/eval/types.ts provides the type contract the parser must output
- Machine-parseable conventions (heading hierarchy, tier comments, table format) are consistent and documented
- Phase 16 can build eval harness against these types and the parsed spec

## Self-Check: PASSED

- Files: test/eval/types.ts FOUND, plugin/BEHAVIORS.md FOUND
- Commits: a172d62 FOUND, 22959eb FOUND
- Tool count: 32/32
- MUST rules: 9 + 1 MUST_NOT = 10 (within 8-12 cap)
- Workflows: 10 (>= 8)
- Anti-patterns: 5 (>= 4)
- Quality criteria: 4 (>= 3)
- Line count: 768 (>= 500)

---
*Phase: 15-behavioral-specification*
*Completed: 2026-03-02*
