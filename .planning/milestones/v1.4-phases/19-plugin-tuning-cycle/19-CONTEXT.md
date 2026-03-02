# Phase 19: Plugin Tuning Cycle - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Iteratively refine plugin artifacts (skills, hooks, agents) based on eval failures until the suite passes at target thresholds. Capture a regression baseline for future CI comparison. Validate tuning doesn't overfit via holdout set. Track token budget to prevent prompt bloat.

Inputs: Phase 18 eval infrastructure (deterministic + LLM scorers), 22 synthetic scenarios, 2 transcript scenarios, BEHAVIORS.md spec.
Outputs: Tuned plugin, regression baseline JSON, holdout validation, TUNING-LOG.md.

</domain>

<decisions>
## Implementation Decisions

### Pass thresholds
- Tiered thresholds: core scorers (sequencing, decision-hygiene, anti-patterns) get stricter targets; quality scorers (quality-criteria, scope-quality, argument-quality) get lower targets
- Evaluate both per-scenario and aggregate — baseline captures per-scenario detail
- MUST-level scorer failures flag the scenario regardless of aggregate score
- Negative scenarios (decide-blind, orient-skips-assemble, etc.) use inverted expectations: they must score LOW to prove scorers catch bad behavior
- Overall target before baseline capture: 95% synthetic + 80% transcript

### Tuning approach
- Group fixes by workflow: orient, decide, verify, coordinate, handoff — fix all failures in one workflow before moving to next
- Run the full eval suite after each individual plugin change — strict no-regression discipline
- Primarily modify plugin artifacts (skills, hooks, agents); allow scenario/scorer fixes only when there's a genuine bug, with documented justification
- Maintain TUNING-LOG.md mapping each change to the specific failure it addresses, with before/after scores per scenario

### Holdout validation
- Create 5-8 new scenarios specifically for holdout — don't split existing training set
- Holdout scenarios tagged in YAML with a holdout flag; main eval run excludes them, holdout run includes only them
- Run holdout validation after completing each workflow batch of tuning
- Overfitting threshold: if holdout scores drop more than 10 percentage points below training scores, flag as overfitting

### Token budget tracking
- Track both per-skill token count and total across all plugin artifacts (skills, agents, hooks)
- Baseline captured from current pre-tuning state (~35KB total, ~8,750 estimated tokens)
- CI script enforces 120% cap on total — fails if exceeded
- When approaching cap: restructure skills by moving shared patterns to plugin-level instructions (plugin.json instructions field or agent prompts) rather than repeating across skills

### Claude's Discretion
- Specific tiered threshold values per scorer (informed by severity and current failure patterns)
- Workflow ordering (which workflow to tackle first based on failure density)
- Holdout scenario design (which behavioral patterns to test, ensuring coverage of unseen combinations)
- Compression and restructuring specifics when approaching token budget

</decisions>

<specifics>
## Specific Ideas

- TUNING-LOG.md should be the primary traceability artifact — each entry maps a plugin change to the eval failure it targets with before/after score snapshots
- Inverted expectations for negative scenarios is key: these validate the eval itself, not the plugin
- The 95% synthetic / 80% transcript split acknowledges that transcript eval is harder (real sessions are messier than synthetic)

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- 9 deterministic + 2 LLM scorers already implemented in `test/eval/scorers/`
- Scenario loader and schema validation in `test/eval/scenario-loader.ts` and `test/eval/scenario-schema.ts`
- Eval runner with vitest integration at `test/eval/eval-runner.eval.ts`
- Transcript analyzer at `test/eval/transcript-analyzer.ts` with 2 real session fixtures
- `DEFAULT_THRESHOLD = 0.8` in `test/eval/scorer-types.ts` — will need per-scorer override mechanism

### Established Patterns
- YAML scenarios define tool call sequences scored by the harness
- Scorers implement `Scorer` interface with `name`, `description`, `score(input, spec)` returning `ScorerResult`
- `aggregateChecks()` uses weighted severity: MUST fail=0, MUST_NOT fail=0, SHOULD fail=0.5
- Plugin skills use SKILL.md with YAML frontmatter; agents use .md system prompts; hooks use shell scripts with hooks.json config

### Integration Points
- `npm run eval:synthetic` runs the synthetic eval suite
- `test/eval/results/latest.json` stores most recent synthetic results
- `test/eval/results/transcript-latest.json` stores transcript results
- Plugin artifacts under `plugin/skills/`, `plugin/agents/`, `plugin/hooks/`
- `plugin/BEHAVIORS.md` is the authoritative behavioral reference (scoring ground truth)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 19-plugin-tuning-cycle*
*Context gathered: 2026-03-02*
