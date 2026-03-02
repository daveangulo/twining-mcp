---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Agent Behavior Quality
status: unknown
last_updated: "2026-03-02T17:55:37.555Z"
progress:
  total_phases: 4
  completed_phases: 4
  total_plans: 9
  completed_plans: 9
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-02)

**Core value:** Agents share *why* decisions were made, not just *what* was done -- eliminating information silos across context windows.
**Current focus:** Phase 18: LLM Judge (v1.4 Agent Behavior Quality)

## Current Position

Phase: 18 of 19 (LLM Judge Integration -- COMPLETE)
Plan: 2 of 2 in current phase (18-02 complete, phase done)
Status: Phase 18 Complete
Last activity: 2026-03-02 -- Completed 18-02 (LLM scorer implementations)

Progress: [██████████████████████████████████████░░░] 95% (18/19 phases, 41/41 v1.4 plans through Phase 18-02)

## Performance Metrics

**Through v1.3:**
- Total GSD plans completed: 32 (6 v1 + 6 v1.1 + 10 v1.2 + 10 v1.3)
- v1.1: ~19min (6 plans), v1.2: ~31min (10 plans), v1.3: ~31min (10 plans)

**Post-v1.3 (unplanned):** 81 commits of hardening, new tools, dashboard redesign, plugin, demo, open source prep

**v1.4:**
- 15-01: 6min (2 tasks, 2 files)
- 15-02: 3min (1 task TDD, 2 files)
- 16-01: 4min (2 tasks TDD, 8 files)
- 16-02: 5min (1 task TDD, 9 files)
- 16-03: 11min (2 tasks, 27 files)
- 17-01: 5min (2 tasks TDD, 7 files)
- 17-02: 3min (1 task, 4 files)
- 18-01: 4min (2 tasks, 14 files)
- 18-02: 2min (2 tasks, 3 files)

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
- Behavioral spec as single Markdown document parsed by state machine into typed objects
- Eval scenarios use flat tool call lists with per-scorer pass/fail expectations
- 7 category scorers with hybrid rule mapping: metadata from BehaviorSpec, custom check logic inline
- Scorer interface decoupled from scenario format: takes ScorerInput + BehaviorSpec, returns ScorerResult
- aggregateChecks weighted severity: MUST/MUST_NOT fail=0, SHOULD fail=0.5, pass=1, mean of all
- DEFAULT_THRESHOLD=0.8 for scorer pass/fail
- Anti-pattern and quality-criteria scorers use named checker maps keyed by BehaviorSpec IDs for extensibility
- Workflow sequencing uses partial matching -- only tools present checked for order
- Scope inflation detection uses simple set membership (project, ., /, empty)
- Scenario expected_scores only assert scorers the scenario specifically tests; undeclared scorers pass vacuously
- Anti-patterns SHOULD-level aggregation requires 3+ violations to breach 0.8 threshold
- Cross-cutting lifecycle scenarios cannot assert sequencing/completeness due to overlapping workflow definitions
- Eval harness uses matrix testing: 22 scenarios × 7 scorers = 154 dynamic vitest tests
- Scorers use weighted severity aggregation: MUST fail=0, SHOULD fail=0.5, pass=1 with DEFAULT_THRESHOLD=0.8
- Transcript parser extracts both tool_use calls and tool_result blocks, follows subagent parentUuid chains
- Segment transcripts into workflow chunks and extend NormalizedToolCall with optional result field
- Separate vitest config and npm script for transcript evals with manifest-based fixture discovery
- MCP tool name normalization via split('__').pop() handles both prefix patterns (verified against 275 real calls)
- JSONL parsing uses Zod safeParse per line -- never throws, collects warnings
- Workflow segmentation at twining_assemble boundaries only; time-gap heuristic deferred to Phase 19
- Transcript manifest uses 0.6 default threshold vs synthetic's 0.8
- Aggregate assertions (avg across scorers) for transcript eval -- per-scorer too strict for real sessions
- Same allScorers array proven on both synthetic and real transcripts (EVAL-05)
- [Phase 17]: Aggregate assertions (avg across all scorers) for transcript eval instead of per-scorer threshold -- real sessions have inherent scorer variance
- Transcript parser uses two-pass JSONL extraction with workflow segmentation at twining_assemble boundaries
- Transcript eval uses 0.6 threshold (vs 0.8 for synthetic) with aggregate average assertions instead of per-scorer
- [Phase 18]: Anthropic SDK as devDependency -- only used in eval, not shipped in production
- [Phase 18]: createJudgeClient returns null when ANTHROPIC_API_KEY unset -- graceful degradation, not crash
- [Phase 18]: Async Scorer interface: all scorers return Promise<ScorerResult>, enabling future LLM scorers
- [Phase 18]: Conditional scorer composition: deterministicScorers always, llmScorers only when TWINING_EVAL_JUDGE=1
- [Phase 18]: SHOULD-level checks for LLM judge results: semantic quality is advisory, not mandatory
- [Phase 18]: 0.5 score threshold per individual judge call (acceptable or good passes)
- [Phase 18]: Per-call LLM evaluation: one judge call per tool call, not batched across calls

### Pending Todos

None.

### Blockers/Concerns

- vitest-evals vitest 4.x compatibility unverified -- 30-line fallback ready (Phase 16)
- Claude Code headless JSON output reliability needs smoke-testing (Phase 18)
- Transcript JSONL exact field structure not officially documented by Anthropic (Phase 17)

## Session Continuity

Last session: 2026-03-02
Stopped at: Completed 18-02-PLAN.md (LLM scorer implementations)
Next: Phase 19 (Plugin Tuning)
