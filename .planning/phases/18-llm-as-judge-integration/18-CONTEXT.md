# Phase 18: LLM-as-Judge Integration - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Add two qualitative LLM-based scorers (rationale quality, scope appropriateness) to the existing eval pipeline, gated behind `TWINING_EVAL_JUDGE=1` so they never run in CI. Non-deterministic scoring uses k>=3 trials with consensus. The `judge.ts` module wraps Claude via the Anthropic SDK and makes one focused judge call per evaluation criterion.

</domain>

<decisions>
## Implementation Decisions

### Claude Invocation
- Use `@anthropic-ai/sdk` (new dependency) — direct programmatic API with structured responses
- Default model: Haiku, configurable via `TWINING_EVAL_MODEL` env var
- API key: standard `ANTHROPIC_API_KEY` env var (skip gracefully if not set)
- Judge responses use structured tool_use — define a tool schema the judge "calls" to return score + rationale, guaranteed parseable

### Judge Prompt Design
- Rubric-graded scoring: feed the judge BEHAVIORS.md quality levels (good/acceptable/bad) as a rubric, judge picks a level + explains why, levels map to numeric scores
- Context per call: relevant tool call(s) with arguments and results, plus scenario metadata (category, description) — not the full sequence
- Rationale quality scorer: evaluates `rationale` and `context` arguments in `twining_decide` calls — are they specific, do they reference concrete constraints vs vague platitudes?
- Scope appropriateness scorer: evaluates whether scope arguments (in `twining_assemble`, `twining_decide`, `twining_post`, etc.) are appropriately narrow for the task, using scenario metadata as ground truth

### Consensus & Trials
- Default k=3 trials, configurable via `TWINING_EVAL_TRIALS` env var
- All k trials fire in parallel (Promise.all) for fast wall-clock time
- Consensus: 2/3 majority agreement; when trials don't reach consensus, use median score
- Report disagreement in output (agreement ratio like "3/3 agreed" or "2/3 majority")
- Full trial-level detail available but default reporting shows consensus + variability summary

### Pipeline Integration
- LLM scorers integrate conditionally into existing runners (eval-runner.eval.ts and transcript-runner.transcript.ts) — not a separate vitest file
- Runners check `TWINING_EVAL_JUDGE=1` and skip LLM scorers when not set
- `Scorer.score()` becomes async (returns `Promise<ScorerResult>`) — deterministic scorers wrap in `Promise.resolve()`, trivial change
- `ScorerResult` gets optional `type: 'deterministic' | 'llm'` field for provenance
- API errors/timeouts produce warnings and skip the LLM scorer for that scenario — eval doesn't fail due to external service issues

### Claude's Discretion
- Exact judge prompt wording and rubric formatting
- Tool schema design for structured responses
- How to extract relevant tool calls per scorer (which calls to feed to which judge)
- Error retry logic within the SDK wrapper
- How to map rubric levels to numeric 0-1 scores

</decisions>

<specifics>
## Specific Ideas

- Each judge call should be focused on ONE criterion — never monolithic prompts (per success criteria)
- BEHAVIORS.md already has quality criteria with graded levels — reuse those as judge rubrics directly
- The existing `QualityCriterion` type (with `QualityLevel[]`) maps naturally to rubric structure

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Scorer` interface (`test/eval/scorer-types.ts`): `name` + `score(input, spec) → ScorerResult` — LLM scorers will implement this same interface (made async)
- `ScorerInput` (`test/eval/scenario-schema.ts`): format-agnostic `NormalizedToolCall[]` — LLM scorers receive the same input
- `BehaviorSpec` with `QualityCriterion[]` (`test/eval/types.ts`): quality criteria with graded levels feed directly into judge rubrics
- `aggregateChecks()` (`test/eval/scorer-types.ts`): weighted severity aggregation, may be reused or adapted for LLM result aggregation
- 7 existing deterministic scorers in `test/eval/scorers/` — pattern to follow for file structure and registration

### Established Patterns
- All scorers registered in `test/eval/scorers/index.ts` via `allScorers` array
- Eval runner loops: scenario x scorer matrix in vitest `describe`/`it` blocks
- Results accumulated and written to `test/eval/results/latest.json`
- Transcript runner uses same scorers with lower threshold (0.6 vs 0.8)

### Integration Points
- `test/eval/scorers/index.ts` — add LLM scorers to `allScorers` (with conditional import/inclusion)
- `test/eval/eval-runner.eval.ts` — needs async scorer support and TWINING_EVAL_JUDGE gating
- `test/eval/transcript-runner.transcript.ts` — same async + gating changes
- `test/eval/scorer-types.ts` — Scorer interface becomes async, ScorerResult gets type field
- `package.json` — new `@anthropic-ai/sdk` dependency

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 18-llm-as-judge-integration*
*Context gathered: 2026-03-02*
