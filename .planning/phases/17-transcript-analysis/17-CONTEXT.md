# Phase 17: Transcript Analysis - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Parse real Claude Code session JSONL transcripts, extract twining_* tool calls into the same normalized format used by Phase 16's synthetic scenarios, and score them with the same deterministic scorers. Validates that synthetic scenarios match actual behavior patterns. LLM-as-judge scoring is Phase 18.

</domain>

<decisions>
## Implementation Decisions

### JSONL parsing strategy
- Extract both `tool_use` content blocks AND `tool_result` content blocks from assistant messages — not just calls
- Follow `parentUuid` chains to include tool calls from subagent conversations (twining-aware-worker, etc.), not just the top-level session
- Handle malformed input defensively: skip unparseable JSON lines and collect warnings, never crash — matches success criteria requirement
- Filter to only `twining_*` tool names after extraction

### Fixture sourcing
- Use full session transcripts as fixtures, not curated excerpts — tests the parser against real-world noise (non-Twining calls, hooks, user messages, progress events)
- Build an automated scrubbing script (`scripts/scrub-transcript.ts`) that strips sensitive content (file contents, user prompts, paths, env vars) while preserving structural data needed for parsing
- Select mixed quality sessions: include both well-used sessions (orient → work → decide → verify) and poorly-used sessions (missing assemble, fire-and-forget decisions) to validate scorers can distinguish good from bad
- At least 2 fixture files as required by success criteria

### Scorer compatibility
- Segment transcripts into identifiable workflow chunks — detect workflow boundaries (e.g., `twining_assemble` = start of new workflow) and score each segment independently for granular results
- Extend `NormalizedToolCall` with an optional `result` field to store tool_result data — existing scorers ignore it, Phase 18 LLM judge will use it
- Use separate (lower) pass/fail thresholds for transcript evals vs synthetic scenarios — real sessions are inherently messier, Phase 19 tuning will improve scores over time
- Include both session-level metadata (source file, session ID) and workflow-level metadata (start index, tool count) in ScorerInput for richer reporting

### CLI and test runner
- Separate vitest config file (`vitest.config.transcript.ts`) with its own `npm run eval:transcript` command — keeps synthetic and transcript runs independent as the success criteria specifies
- Use a manifest file (JSON or YAML) to list fixtures with metadata (session description, expected quality level, tags) rather than bare glob discovery
- Standalone scrubbing script run as a prep step before committing fixtures — raw transcripts never enter the repo

### Claude's Discretion
- Memory strategy for JSONL loading (load full file vs streaming) — pick simplest approach that handles typical session sizes
- Fixture file location within test/eval/ directory structure
- Reporter approach for transcript eval output (reuse existing or extend)
- Exact workflow segmentation heuristics (how to detect workflow boundaries beyond assemble calls)

</decisions>

<specifics>
## Specific Ideas

- Claude Code JSONL format has multiple message types: `user`, `assistant`, `progress`, `file-history-snapshot` — tool calls live in `assistant` messages as content blocks with `type: "tool_use"`
- Tool results appear as content blocks with `type: "tool_result"` in subsequent messages
- Subagent messages share the same `sessionId` but have different `parentUuid` chains
- The existing `ScorerInput` interface (`calls: NormalizedToolCall[]`, `metadata?: Record<string, unknown>`) is the target format — transcript parser must produce this
- The `normalizeScenario()` function in `scenario-schema.ts` shows the pattern: map tool calls to `{ tool, arguments, index }`

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `NormalizedToolCall` interface (`test/eval/scenario-schema.ts`): Target format for extracted tool calls — needs optional `result` field added
- `ScorerInput` interface (`test/eval/scenario-schema.ts`): What scorers receive — calls[] + metadata
- `Scorer` interface + `aggregateChecks()` (`test/eval/scorer-types.ts`): All 7 scorers implement this, score() takes ScorerInput + BehaviorSpec
- `allScorers` registry (`test/eval/scorers/index.ts`): 7 deterministic scorers ready to apply to transcript data
- `vitest.config.eval.ts`: Pattern for separate eval vitest config
- `eval-reporter.ts`: Custom vitest reporter for eval output

### Established Patterns
- Zod schemas for runtime validation (scenario-schema.ts uses `z.object` for YAML scenarios)
- `normalizeScenario()` converts format-specific data to scorer-agnostic `ScorerInput`
- YAML scenario files in `test/eval/scenarios/` with `expected_scores` for pass/fail assertions
- `eval-runner.eval.ts` loads scenarios, runs scorers, checks expectations

### Integration Points
- `NormalizedToolCall` in `scenario-schema.ts` — extend with optional `result` field
- `ScorerInput` — transcript parser produces this same type
- `allScorers` — same scorer array applied to transcript-sourced input
- `vitest.config.eval.ts` — pattern for creating `vitest.config.transcript.ts`
- `package.json` scripts — add `eval:transcript` alongside existing `eval:synthetic`

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 17-transcript-analysis*
*Context gathered: 2026-03-02*
