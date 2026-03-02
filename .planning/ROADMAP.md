# Roadmap: Twining MCP Server

## Milestones

- ✅ **v1** -- Phases 1-3 (shipped 2026-02-17)
- ✅ **v1.1 Integrations + Polish** -- Phases 4-6 (shipped 2026-02-17)
- ✅ **v1.2 Web Dashboard** -- Phases 7-10 (shipped 2026-02-17)
- ✅ **v1.3 Agent Coordination** -- Phases 11-14 (shipped 2026-02-17)
- 🚧 **v1.4 Agent Behavior Quality** -- Phases 15-19 (in progress)

## Phases

<details>
<summary>✅ v1 (Phases 1-3) -- SHIPPED 2026-02-17</summary>

- [x] Phase 1: Foundation + Core Data (2/2 plans) -- completed 2026-02-16
- [x] Phase 2: Intelligence (2/2 plans) -- completed 2026-02-16
- [x] Phase 3: Graph + Lifecycle (2/2 plans) -- completed 2026-02-17

</details>

<details>
<summary>✅ v1.1 Integrations + Polish (Phases 4-6) -- SHIPPED 2026-02-17</summary>

- [x] Phase 4: Git Commit Linking (2/2 plans) -- completed 2026-02-17
- [x] Phase 5: GSD Planning Bridge + Serena Docs (2/2 plans) -- completed 2026-02-17
- [x] Phase 6: Search + Export (2/2 plans) -- completed 2026-02-17

</details>

<details>
<summary>✅ v1.2 Web Dashboard (Phases 7-10) -- SHIPPED 2026-02-17</summary>

- [x] Phase 7: HTTP Server Foundation (3/3 plans) -- completed 2026-02-17
- [x] Phase 8: Observability Dashboard (2/2 plans) -- completed 2026-02-17
- [x] Phase 9: Search and Filter (2/2 plans) -- completed 2026-02-17
- [x] Phase 10: Visualizations and Polish (3/3 plans) -- completed 2026-02-17

</details>

<details>
<summary>✅ v1.3 Agent Coordination (Phases 11-14) -- SHIPPED 2026-02-17</summary>

- [x] Phase 11: Types and Storage (3/3 plans) -- completed 2026-02-17
- [x] Phase 12: Coordination Engine (3/3 plans) -- completed 2026-02-17
- [x] Phase 13: Tools and Assembly (2/2 plans) -- completed 2026-02-17
- [x] Phase 14: Agent Dashboard (2/2 plans) -- completed 2026-02-17

</details>

### 🚧 v1.4 Agent Behavior Quality (In Progress)

**Milestone Goal:** Define what correct Twining usage looks like for AI agents, build evaluation infrastructure to measure it, and tune the plugin until agents behave well.

- [x] **Phase 15: Behavioral Specification** - Machine-parseable behavioral rules, workflow scenarios, and quality criteria for all 32 MCP tools (completed 2026-03-02)
- [x] **Phase 16: Eval Harness -- Deterministic Core** - Synthetic scenario engine, deterministic scorers, vitest eval config, and 20+ YAML scenarios (completed 2026-03-02)
- [x] **Phase 17: Transcript Analysis** - Real Claude Code transcript parsing with the same scorers applied to actual dogfooding sessions (completed 2026-03-02)
- [ ] **Phase 18: LLM-as-Judge Integration** - Qualitative semantic scorers for rationale quality and scope appropriateness behind env-var gate
- [ ] **Phase 19: Plugin Tuning Cycle** - Iterative skill/hook/agent refinement validated against the eval suite with regression baseline

## Phase Details

### Phase 15: Behavioral Specification
**Goal**: A single authoritative document defines what correct Twining usage looks like, machine-parseable by the eval harness, covering all 32 tools with rules, workflows, quality criteria, and anti-patterns
**Depends on**: Phase 14 (v1.3 complete; existing plugin skills and tools are the inputs)
**Requirements**: SPEC-01, SPEC-02, SPEC-03, SPEC-04, SPEC-05, SPEC-06, QUAL-01, QUAL-02, QUAL-03, QUAL-04
**Success Criteria** (what must be TRUE):
  1. `plugin/BEHAVIORS.md` exists with MUST/SHOULD/MUST_NOT rules for all 32 MCP tools, organized by tier (Tier 1 core with full depth, Tier 2 supporting with lighter coverage)
  2. Each Tier 1 tool entry includes usage context, correct usage example, and incorrect usage example; each Tier 2 tool has at minimum a behavioral rule and anti-pattern
  3. At least 8 workflow scenarios define expected multi-tool sequences (orient, decide, verify, coordinate, handoff, etc.) with named steps
  4. Anti-pattern catalog and quality criteria (scope precision, rationale quality, parameter content quality) are documented with concrete bad/good examples
  5. A `test/eval/behaviors-parser.ts` can parse BEHAVIORS.md into structured TypeScript objects and a test suite validates the parser against the actual file
**Plans**: 2 plans

Plans:
- [x] 15-01-PLAN.md -- Types and behavioral specification (plugin/BEHAVIORS.md with all 32 tools, workflows, anti-patterns, quality criteria)
- [x] 15-02-PLAN.md -- Behaviors parser and test suite (TDD parser for BEHAVIORS.md into structured TypeScript objects)

### Phase 16: Eval Harness -- Deterministic Core
**Goal**: A working eval system runs deterministic scorers against synthetic YAML scenarios via vitest, producing pass/fail results with per-scenario breakdown
**Depends on**: Phase 15 (behavioral rules and quality criteria are the scoring reference)
**Requirements**: EVAL-01, EVAL-02, EVAL-08, EVAL-09
**Success Criteria** (what must be TRUE):
  1. `vitest.config.eval.ts` exists and `npm run eval:synthetic` executes the eval suite independently from the main test suite
  2. YAML scenario files in `test/eval/scenarios/` define tool call sequences and the scenario engine loads and validates them against a zod schema
  3. At least 7 deterministic scorers check structural behavioral patterns (sequencing, argument quality, ordering, scope narrowness, etc.) and produce numeric scores
  4. 20+ synthetic scenarios exist across all workflow categories (orient, decide, verify, coordinate, handoff, etc.)
  5. Scorer interface is format-agnostic -- accepts a normalized tool call sequence, not scenario-specific types -- so the same scorers can later consume transcript data
**Plans**: 3 plans

Plans:
- [x] 16-01-PLAN.md -- Eval foundation: normalized types, scenario schema, scenario loader, vitest eval config, npm scripts
- [x] 16-02-PLAN.md -- 7 deterministic category scorers with unit tests (sequencing, scope, argument, decision hygiene, workflow, anti-patterns, quality)
- [x] 16-03-PLAN.md -- 22+ YAML scenarios, eval test runner, custom reporter, end-to-end eval pipeline

### Phase 17: Transcript Analysis
**Goal**: Real Claude Code session transcripts are parsed and scored by the same deterministic scorers, validating that synthetic scenarios match actual behavior patterns
**Depends on**: Phase 16 (scorer pipeline and normalized interface must exist)
**Requirements**: EVAL-04, EVAL-05
**Success Criteria** (what must be TRUE):
  1. `test/eval/transcript-analyzer.ts` parses Claude Code JSONL session logs and extracts `twining_*` tool calls into the same normalized format used by synthetic scenarios
  2. The parser handles format variations defensively (missing fields, unexpected structures) with type guards and does not crash on malformed input
  3. `npm run eval:transcript` runs the transcript eval suite and applies the same deterministic scorers that work on synthetic scenarios
  4. At least 2 real transcript fixtures from actual dogfooding sessions are included and produce scored results
**Plans**: 2 plans

Plans:
- [x] 17-01-PLAN.md -- Transcript parser, scrubbing script, and real session fixtures
- [x] 17-02-PLAN.md -- Transcript eval runner with vitest config and npm scripts

### Phase 18: LLM-as-Judge Integration
**Goal**: Qualitative aspects that deterministic scorers cannot check (rationale specificity, scope appropriateness) are evaluated by an LLM judge, gated behind an env var so they never run in CI
**Depends on**: Phase 17 (full deterministic pipeline validated on both synthetic and real data)
**Requirements**: EVAL-03, EVAL-06, EVAL-07
**Success Criteria** (what must be TRUE):
  1. `test/eval/judge.ts` wraps Claude (headless or SDK) and makes one focused judge call per evaluation criterion, never monolithic prompts
  2. Two LLM-based scorers exist (rationale quality, scope appropriateness) and integrate into the existing scorer pipeline
  3. LLM judge scorers only execute when `TWINING_EVAL_JUDGE=1` is set; without it, eval suite runs deterministic scorers only
  4. Non-deterministic scenarios run k>=3 trials with consensus scoring (2/3 agreement) to handle LLM variability
**Plans**: 2 plans

Plans:
- [ ] 18-01-PLAN.md -- Judge wrapper, async scorer interface, conditional registry, runner updates
- [ ] 18-02-PLAN.md -- Two LLM scorers (rationale quality, scope appropriateness) with consensus scoring

### Phase 19: Plugin Tuning Cycle
**Goal**: Plugin artifacts (skills, hooks, agents) are iteratively refined based on eval failures until the suite passes at target thresholds, with a regression baseline captured for future comparison
**Depends on**: Phase 18 (full scoring capability -- deterministic + qualitative -- needed for informed tuning)
**Requirements**: TUNE-01, TUNE-02, TUNE-03, TUNE-04, TUNE-05
**Success Criteria** (what must be TRUE):
  1. Plugin skills, hooks, and agents have been modified based on specific eval failures and the changes are traceable to those failures
  2. The tuned plugin passes the eval suite at defined score thresholds (thresholds documented in eval config)
  3. A regression baseline JSON file captures eval scores per scenario for future CI comparison
  4. Plugin token budget is measured before and after tuning; total prompt growth stays under 20%
  5. A holdout eval set (scenarios not used during tuning) validates that tuning generalizes and does not overfit to the training scenarios
**Plans**: TBD

Plans:
- [ ] 19-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 15 -> 16 -> 17 -> 18 -> 19

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation + Core Data | v1 | 2/2 | Complete | 2026-02-16 |
| 2. Intelligence | v1 | 2/2 | Complete | 2026-02-16 |
| 3. Graph + Lifecycle | v1 | 2/2 | Complete | 2026-02-17 |
| 4. Git Commit Linking | v1.1 | 2/2 | Complete | 2026-02-17 |
| 5. GSD Planning Bridge + Serena Docs | v1.1 | 2/2 | Complete | 2026-02-17 |
| 6. Search + Export | v1.1 | 2/2 | Complete | 2026-02-17 |
| 7. HTTP Server Foundation | v1.2 | 3/3 | Complete | 2026-02-17 |
| 8. Observability Dashboard | v1.2 | 2/2 | Complete | 2026-02-17 |
| 9. Search and Filter | v1.2 | 2/2 | Complete | 2026-02-17 |
| 10. Visualizations and Polish | v1.2 | 3/3 | Complete | 2026-02-17 |
| 11. Types and Storage | v1.3 | 3/3 | Complete | 2026-02-17 |
| 12. Coordination Engine | v1.3 | 3/3 | Complete | 2026-02-17 |
| 13. Tools and Assembly | v1.3 | 2/2 | Complete | 2026-02-17 |
| 14. Agent Dashboard | v1.3 | 2/2 | Complete | 2026-02-17 |
| 15. Behavioral Specification | v1.4 | 2/2 | Complete | 2026-03-02 |
| 16. Eval Harness -- Deterministic Core | v1.4 | 3/3 | Complete | 2026-03-02 |
| 17. Transcript Analysis | v1.4 | 2/2 | Complete | 2026-03-02 |
| 18. LLM-as-Judge Integration | 1/2 | In Progress|  | - |
| 19. Plugin Tuning Cycle | v1.4 | 0/? | Not started | - |
