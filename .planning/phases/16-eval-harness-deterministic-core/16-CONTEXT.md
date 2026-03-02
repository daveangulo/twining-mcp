# Phase 16: Eval Harness -- Deterministic Core - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

A working eval system that runs deterministic scorers against synthetic YAML scenarios via vitest, producing pass/fail results with per-scenario breakdown. Covers EVAL-01, EVAL-02, EVAL-08, EVAL-09. Transcript analysis (Phase 17), LLM-as-judge (Phase 18), and plugin tuning (Phase 19) are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Scenario Format
- Flat tool list: each scenario has a simple array of `tool_calls` with tool name + arguments -- scorers infer patterns from the sequence
- Calls only, no mock responses -- scorers evaluate structural patterns in the call sequence, not reactions to responses
- Per-scorer expectations: each scenario declares `expected_scores` mapping scorer names to pass/fail, so a scenario can be good on sequencing but bad on scope narrowness
- Light metadata: `name`, `description`, `category`, `tags` array for filtering, `tool_calls`, `expected_scores`
- Zod schema validates all YAML scenarios at load time

### Scorer Design
- 7 category scorers covering logical groupings: sequencing, scope quality, argument quality, decision hygiene, workflow completeness, anti-patterns, quality criteria
- Each scorer returns both numeric 0-1 score AND individual check pass/fail with details -- numeric for thresholds/trends, checks for diagnostics
- Hybrid rule mapping: scorers reference parsed BehaviorSpec for rule metadata (IDs, levels, descriptions) but implement check logic inline with custom functions
- Weighted severity: MUST violations score 0, SHOULD violations score 0.5, MUST_NOT violations score 0 -- aggregated to category score
- Format-agnostic scorer interface: accepts normalized tool call sequences so same scorers work on transcript data in Phase 17

### Result Reporting
- Vitest handles test execution, then custom reporter prints summary table with per-category scores, overall pass rate, and worst-performing scenarios
- JSON results written to `test/eval/results/latest.json` after each run for programmatic comparison
- Global default threshold (0.8) with per-scenario override via `expected_scores`

### Scenario Coverage
- One YAML file per scenario in flat `test/eval/scenarios/` directory, named by category prefix: `orient-happy-path.yaml`, `decide-no-alternatives.yaml`
- All 5 core workflow categories: orient, decide, verify, coordinate, handoff (~4-5 scenarios each)
- Balanced ~50/50 happy-path vs violation scenarios
- Mix of short focused scenarios (2-3 calls testing specific rules) and longer realistic workflows (5-8 calls testing full sequences)
- 20+ scenarios total across all categories

### Claude's Discretion
- Exact scorer implementation details and helper functions
- Normalized tool call interface shape (as long as it's format-agnostic)
- Vitest config structure for eval suite isolation
- Summary table formatting details
- JSON results schema details

</decisions>

<specifics>
## Specific Ideas

- Scorers should trace rule IDs back to BEHAVIORS.md entries (e.g., "ASSEMBLE-01") for easy debugging
- The summary table should highlight worst-performing scenarios to guide Phase 19 tuning
- Scenario tags like `gate-1`, `tier-1-tools` enable filtered runs

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `test/eval/types.ts`: Full Zod schemas + TypeScript interfaces for BehaviorSpec (tools, workflows, anti-patterns, quality criteria) -- scorers will import these
- `test/eval/behaviors-parser.ts`: State-machine parser for `plugin/BEHAVIORS.md` -- scorers call this to get rule metadata
- `vitest.config.ts`: Existing main test config -- eval config extends or parallels this
- Zod validation pattern: already used extensively for runtime schema validation

### Established Patterns
- Co-located tests: `.test.ts` next to implementation
- Vitest with `describe`/`it`/`expect` structure
- Temp directories for test isolation
- Structured error objects with `error`, `code`, `details` fields
- TypeScript strict mode with Zod runtime validation

### Integration Points
- `package.json` needs new scripts: `eval`, `eval:synthetic`
- `vitest.config.eval.ts` runs independently from main test suite
- Behaviors parser provides the BehaviorSpec that scorers reference
- Results JSON at `test/eval/results/latest.json` consumed by Phase 19 for regression baseline

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope

</deferred>

---

*Phase: 16-eval-harness-deterministic-core*
*Context gathered: 2026-03-02*
