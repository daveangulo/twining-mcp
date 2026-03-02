# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-02)

**Core value:** Agents share *why* decisions were made, not just *what* was done -- eliminating information silos across context windows.
**Current focus:** Phase 15: Behavioral Specification (v1.4 Agent Behavior Quality)

## Current Position

Phase: 15 of 19 (Behavioral Specification) -- COMPLETE
Plan: 2 of 2 in current phase
Status: Phase complete
Last activity: 2026-03-02 -- Completed 15-02 (behaviors parser)

Progress: [██████████████████████████████░░░░░░░░░░░] 76% (15/19 phases, 34/34 v1.4 plans)

## Performance Metrics

**Through v1.3:**
- Total GSD plans completed: 32 (6 v1 + 6 v1.1 + 10 v1.2 + 10 v1.3)
- v1.1: ~19min (6 plans), v1.2: ~31min (10 plans), v1.3: ~31min (10 plans)

**Post-v1.3 (unplanned):** 81 commits of hardening, new tools, dashboard redesign, plugin, demo, open source prep

**v1.4:**
- 15-01: 6min (2 tasks, 2 files)
- 15-02: 3min (1 task TDD, 2 files)

## Accumulated Context

### Decisions

All decisions archived in PROJECT.md Key Decisions table with outcomes.
Recent decisions affecting current work:

- v1.4 milestone: Behavioral spec + eval harness + plugin tuning as single release
- Eval system is orthogonal to MCP server -- zero imports from src/tools/, src/engine/, src/storage/
- Deterministic scorers only in CI; LLM judge behind TWINING_EVAL_JUDGE=1 env-var gate
- Hard cap: 8-12 MUST rules across all 32 tools to prevent over-specification
- Holdout eval set for Goodhart's Law mitigation
- MUST rule allocation: 10 total (9 MUST + 1 MUST_NOT) across DECIDE(3), POST(2), ASSEMBLE(1), HANDOFF(1), VERIFY(1), ENTITY(1), RELATION(1)
- State machine parser for BEHAVIORS.md -- no markdown AST library, format-specific extraction
- Eval tests use real BEHAVIORS.md, not fixtures -- single source of truth

### Pending Todos

None.

### Blockers/Concerns

- vitest-evals vitest 4.x compatibility unverified -- 30-line fallback ready (Phase 16)
- Claude Code headless JSON output reliability needs smoke-testing (Phase 18)
- Transcript JSONL exact field structure not officially documented by Anthropic (Phase 17)

## Session Continuity

Last session: 2026-03-02
Stopped at: Completed 15-02-PLAN.md (behaviors parser)
Next: Execute Phase 16 (eval harness)
