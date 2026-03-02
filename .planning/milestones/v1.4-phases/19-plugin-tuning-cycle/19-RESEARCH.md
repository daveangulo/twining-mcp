# Phase 19: Plugin Tuning Cycle - Research

**Researched:** 2026-03-02
**Domain:** Plugin prompt engineering, eval-driven iterative refinement, regression baselining
**Confidence:** HIGH

## Summary

Phase 19 is a process-oriented phase, not a feature-building phase. The eval infrastructure (22 synthetic scenarios, 2 transcript fixtures, 9 deterministic + 2 LLM scorers) is fully built. The task is to iteratively modify plugin artifacts (8 skills, 2 agents, 3 hooks) based on eval failures, capture a regression baseline, create holdout scenarios for overfitting validation, and track token budget growth.

The current eval state shows 80.3% test pass rate (159/198 scenario-scorer combinations) with overall score of 0.8998. Most failures are in negative/violation scenarios (expected behavior -- scorers catching bad patterns) and in cross-cutting scenarios. The "decide" category has the lowest pass rate at 66.7%, but this is because it contains the most negative test scenarios. The key challenge is understanding which failures indicate genuine plugin problems (tuning needed) versus correctly-detected violations (expected failures that validate the scorers).

**Primary recommendation:** Categorize all 39 current failures into "expected negative" (scorer correctly catching bad behavior) vs "unexpected negative" (plugin instruction gap that should be fixed), implement per-scorer threshold overrides in the eval runner, then tune plugin skills workflow-by-workflow with strict no-regression discipline.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Tiered thresholds: core scorers (sequencing, decision-hygiene, anti-patterns) get stricter targets; quality scorers (quality-criteria, scope-quality, argument-quality) get lower targets
- Evaluate both per-scenario and aggregate -- baseline captures per-scenario detail
- MUST-level scorer failures flag the scenario regardless of aggregate score
- Negative scenarios (decide-blind, orient-skips-assemble, etc.) use inverted expectations: they must score LOW to prove scorers catch bad behavior
- Overall target before baseline capture: 95% synthetic + 80% transcript
- Group fixes by workflow: orient, decide, verify, coordinate, handoff -- fix all failures in one workflow before moving to next
- Run the full eval suite after each individual plugin change -- strict no-regression discipline
- Primarily modify plugin artifacts (skills, hooks, agents); allow scenario/scorer fixes only when there's a genuine bug, with documented justification
- Maintain TUNING-LOG.md mapping each change to the specific failure it addresses, with before/after scores per scenario
- Create 5-8 new scenarios specifically for holdout -- don't split existing training set
- Holdout scenarios tagged in YAML with a holdout flag; main eval run excludes them, holdout run includes only them
- Run holdout validation after completing each workflow batch of tuning
- Overfitting threshold: if holdout scores drop more than 10 percentage points below training scores, flag as overfitting
- Track both per-skill token count and total across all plugin artifacts (skills, agents, hooks)
- Baseline captured from current pre-tuning state (~35KB total, ~8,750 estimated tokens)
- CI script enforces 120% cap on total -- fails if exceeded
- When approaching cap: restructure skills by moving shared patterns to plugin-level instructions (plugin.json instructions field or agent prompts) rather than repeating across skills

### Claude's Discretion
- Specific tiered threshold values per scorer (informed by severity and current failure patterns)
- Workflow ordering (which workflow to tackle first based on failure density)
- Holdout scenario design (which behavioral patterns to test, ensuring coverage of unseen combinations)
- Compression and restructuring specifics when approaching token budget

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TUNE-01 | Skills/hooks/agents iteratively updated based on eval failures | Current failure analysis (39 failures across 7 scorers) identifies specific plugin gaps; workflow-grouped tuning approach with TUNING-LOG.md traceability |
| TUNE-02 | Tuned plugin passes eval suite at defined score thresholds | Per-scorer tiered threshold mechanism with inverted expectations for negative scenarios; target 95% synthetic / 80% transcript |
| TUNE-03 | Regression baseline JSON captures eval scores for future CI comparison | Extend existing latest.json format with per-scenario detail, scorer thresholds, and metadata for CI comparison |
| TUNE-04 | Plugin token budget tracked; prompt growth stays under 20% cap | Pre-tuning baseline: 34,838 bytes / ~8,710 tokens across 13 artifacts; 120% cap = ~41,806 bytes; token counting script |
| TUNE-05 | Holdout eval set validates tuning doesn't overfit | 5-8 new YAML scenarios with `holdout: true` tag; separate npm script; 10pp overfitting threshold |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | existing | Test runner for eval suite | Already configured with eval/transcript configs |
| yaml (js-yaml) | existing | Parse YAML scenarios | Already used by scenario-loader |
| zod | existing | Schema validation for scenarios | Already used for ScenarioSchema |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node.js fs/path | built-in | File I/O for baseline, token counting | All scripts |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom token counter | tiktoken | tiktoken adds a native dependency; character/4 approximation is sufficient for budget tracking since we care about relative growth, not exact tokens |
| Separate holdout runner | vitest filter flag | Holdout tag in YAML + scenario-loader filter is simpler than a new vitest config |

**Installation:**
No new dependencies needed. All infrastructure is already in place.

## Architecture Patterns

### Current Eval Architecture
```
test/eval/
  scenarios/             # 22 YAML synthetic scenarios
  fixtures/              # 2 JSONL transcript fixtures
  scorers/
    index.ts             # 7 deterministic + 2 LLM scorers
    sequencing.ts        # Workflow step ordering
    scope-quality.ts     # Scope argument specificity
    argument-quality.ts  # Tool argument content quality
    decision-hygiene.ts  # Decision workflow patterns
    workflow-completeness.ts  # Workflow step coverage
    anti-patterns.ts     # Behavioral anti-pattern detection
    quality-criteria.ts  # Quality criterion compliance
    rationale-judge.ts   # LLM: rationale specificity
    scope-judge.ts       # LLM: scope appropriateness
  eval-runner.eval.ts    # Synthetic runner (npm run eval:synthetic)
  transcript-runner.transcript.ts  # Transcript runner (npm run eval:transcript)
  results/
    latest.json          # Synthetic results
    transcript-latest.json  # Transcript results
  eval-reporter.ts       # Console summary reporter

plugin/
  skills/                # 8 SKILL.md files (tuning targets)
  agents/                # 2 agent .md files (tuning targets)
  hooks/                 # 2 .sh + 1 .json (tuning targets)
  BEHAVIORS.md           # Behavioral spec (scoring ground truth)
```

### Pattern 1: Per-Scorer Threshold Override
**What:** Replace `DEFAULT_THRESHOLD = 0.8` with per-scorer configurable thresholds
**When to use:** When core scorers need stricter thresholds and quality scorers need lower ones
**Example:**
```typescript
// In scorer-types.ts or a new thresholds config
export const SCORER_THRESHOLDS: Record<string, number> = {
  // Core scorers -- stricter
  "sequencing": 0.9,
  "decision-hygiene": 0.9,
  "anti-patterns": 0.9,
  // Quality scorers -- more lenient
  "scope-quality": 0.7,
  "argument-quality": 0.7,
  "quality-criteria": 0.7,
  // Completeness
  "workflow-completeness": 0.8,
  // LLM scorers -- advisory
  "rationale-judge": 0.5,
  "scope-judge": 0.5,
};

export function getThreshold(scorerName: string): number {
  return SCORER_THRESHOLDS[scorerName] ?? DEFAULT_THRESHOLD;
}
```

### Pattern 2: Inverted Expectations for Negative Scenarios
**What:** Negative scenarios (violations) expect scorers to return LOW scores -- they validate the eval, not the plugin
**When to use:** Scenarios tagged "violation" like decide-blind, orient-skips-assemble
**Example:**
```yaml
# Existing format already supports this via expected_scores:
name: "Decide blind"
tags: [violation, tier-1-tools]
expected_scores:
  decision-hygiene: false  # MUST fail -- proves scorer catches blind decisions
```
The current system already handles this correctly. The 39 failures include BOTH legitimate failures (plugin gaps) AND expected failures (negative scenarios correctly caught). The key work is classifying which is which.

### Pattern 3: Holdout Scenario Tagging
**What:** YAML tag field + scenario-loader filter to separate holdout from training
**When to use:** Holdout validation after each workflow tuning batch
**Example:**
```yaml
name: "Orient with delayed assembly"
description: "Agent calls status then assemble then decide -- valid workflow"
category: orient
tags: [happy-path, holdout]
holdout: true
tool_calls:
  # ...
expected_scores:
  sequencing: true
```

### Pattern 4: Regression Baseline JSON
**What:** Structured JSON capturing per-scenario, per-scorer scores with metadata
**When to use:** After tuning is complete, before phase gate
**Example:**
```json
{
  "version": "1.0",
  "timestamp": "2026-03-02T...",
  "thresholds": { "sequencing": 0.9, "decision-hygiene": 0.9, ... },
  "token_budget": { "pre_tuning_bytes": 34838, "post_tuning_bytes": ..., "growth_pct": ... },
  "aggregate": {
    "synthetic_pass_rate": 0.95,
    "transcript_pass_rate": 0.80
  },
  "scenarios": [
    {
      "name": "Decide happy path",
      "category": "decide",
      "tags": ["happy-path"],
      "scores": {
        "sequencing": { "score": 1.0, "passed": true, "threshold": 0.9 },
        ...
      }
    }
  ]
}
```

### Pattern 5: Token Budget Tracking Script
**What:** Shell or Node script measuring bytes/estimated tokens of all plugin artifacts
**When to use:** Before and after each tuning batch, enforced in CI
**Example:**
```bash
#!/bin/bash
# measure-plugin-tokens.sh
TOTAL=0
for f in plugin/skills/*/SKILL.md plugin/agents/*.md plugin/hooks/*.sh plugin/hooks/*.json; do
  SIZE=$(wc -c < "$f")
  TOKENS=$((SIZE / 4))
  printf "%-50s %6d bytes  ~%5d tokens\n" "$f" "$SIZE" "$TOKENS"
  TOTAL=$((TOTAL + SIZE))
done
echo "---"
echo "Total: $TOTAL bytes (~$((TOTAL / 4)) tokens)"

# Check against cap
CAP=41806  # 120% of 34838
if [ "$TOTAL" -gt "$CAP" ]; then
  echo "FAIL: Token budget exceeded ($TOTAL > $CAP)"
  exit 1
fi
```

### Anti-Patterns to Avoid
- **Tuning to the test:** Modifying plugin instructions to pass specific scenario patterns rather than improving general behavioral guidance. The holdout set (TUNE-05) mitigates this.
- **Scatter-shot changes:** Changing multiple skills at once makes it impossible to attribute score improvements. Change one skill, run full suite, record delta.
- **Scenario/scorer fixes masquerading as tuning:** If a scenario has a bug (wrong expected_scores), fix it with documented justification, but don't count it as a tuning improvement.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token counting | Custom tokenizer | Byte count / 4 approximation | Exact token counts irrelevant; relative growth is what matters |
| Results comparison | Custom diff tool | JSON diff in TUNING-LOG.md | Human-readable before/after is more valuable than automated diff |
| Threshold configuration | Config file parser | TypeScript const object | 9 scorers, static values, no runtime config needed |

**Key insight:** This phase is about the tuning PROCESS, not building new infrastructure. Most of the tooling exists. The work is iterative refinement of existing plugin text.

## Common Pitfalls

### Pitfall 1: Confusing Expected Failures with Plugin Gaps
**What goes wrong:** Treating negative scenario failures as problems to fix when they are actually correct behavior (scorer catching violations)
**Why it happens:** The 39 failures include both genuine gaps AND expected detection of bad behavior
**How to avoid:** Classify every failure as "expected negative" (scenario is a violation, scorer should fail) or "unexpected failure" (happy-path scenario failing, or scorer catching something it shouldn't in this scenario)
**Warning signs:** Trying to make "decide-blind" pass sequencing -- it SHOULD fail

### Pitfall 2: Over-Specifying Plugin Instructions
**What goes wrong:** Adding so much detail to skills that token budget explodes past 120% cap
**Why it happens:** Each failure tempts adding a paragraph of instruction
**How to avoid:** Prefer concise, rule-based additions. "ALWAYS call twining_assemble before twining_decide" is better than a paragraph explaining why. Move shared patterns to agent-level prompts.
**Warning signs:** Individual SKILL.md exceeding 5KB; total approaching 41KB

### Pitfall 3: Regression During Tuning
**What goes wrong:** Fixing one scenario breaks another because skills overlap
**Why it happens:** Multiple scenarios test the same skill from different angles
**How to avoid:** Run full eval suite after EVERY change (as per locked decision). If a change causes regression, revert and find a different approach.
**Warning signs:** Score going down in scenarios you didn't target

### Pitfall 4: Goodhart's Law (Teaching to the Test)
**What goes wrong:** Plugin passes training scenarios but fails on novel situations
**Why it happens:** Instructions become overly specific to scenario patterns rather than expressing general behavioral principles
**How to avoid:** Holdout set (TUNE-05) validates generalization. Keep skill instructions principle-based, not pattern-matched.
**Warning signs:** Training scores at 100% but holdout drops >10pp below

### Pitfall 5: Incorrect Threshold Tiers
**What goes wrong:** Setting thresholds too strict causes legitimate scenarios to fail; too lenient masks real problems
**Why it happens:** No empirical basis for threshold values
**How to avoid:** Analyze current score distributions. Set thresholds at a level where happy-path scenarios pass but violation scenarios fail. Use the 39 failure analysis as calibration data.
**Warning signs:** More than 5% of happy-path scenarios failing at the chosen thresholds

## Code Examples

### Current Failure Classification

Based on analysis of latest.json (22 scenarios x 9 scorers = 198 tests, 39 failures):

**Failure density by scorer:**
| Scorer | Failures | Notes |
|--------|----------|-------|
| workflow-completeness | 7 | Mostly minimal/violation scenarios missing steps |
| argument-quality | 6 | Violations with empty/missing args (expected) |
| decision-hygiene | 6 | Blind decisions, fire-and-forget (expected for violations) |
| quality-criteria | 6 | Broad scope, short rationale in violation scenarios |
| sequencing | 5 | Out-of-order in violation and cross-cutting scenarios |
| anti-patterns | 5 | Correctly detecting anti-patterns in violation scenarios |
| scope-quality | 4 | Broad scope in violation scenarios |

**Category pass rates:**
| Category | Pass Rate | Notes |
|----------|-----------|-------|
| coordinate | 92.6% (25/27) | Near target |
| verify | 91.7% (33/36) | Near target |
| orient | 80.0% (36/45) | Contains negative scenarios |
| handoff | 80.6% (29/36) | Contains negative scenarios |
| decide | 66.7% (36/54) | Most negative scenarios |

**Key negative scenarios (expected to fail specific scorers):**
- `decide-blind`: decision-hygiene false (correct)
- `decide-fire-and-forget`: multiple scorers false (correct -- deliberately bad scenario)
- `decide-no-rationale`: argument-quality, quality-criteria false (correct)
- `orient-skips-assemble`: multiple scorers false (correct)
- `orient-broad-scope`: scope-quality, quality-criteria false (correct)
- `cross-cutting-anti-pattern-combo`: multiple scorers false (correct -- combo of violations)
- `handoff-inaccurate-status`: multiple scorers false (correct)

**Scenarios needing analysis (may need tuning OR threshold adjustment):**
- `coordinate-minimal`: workflow-completeness=0.5 (only pass/fail -- may need threshold tuning)
- `orient-minimal`: workflow-completeness=0.5 (same pattern)
- `verify-happy-path`: workflow-completeness=0.6667 (happy path should pass)
- `verify-incomplete`: workflow-completeness=0.5 (intended violation?)
- `cross-cutting-full-lifecycle`: sequencing=0.75 (complex scenario -- may need threshold)
- `handoff-without-verify`: sequencing=0.75, workflow-completeness=0.75 (expected -- skipped verify)

### Extending ScenarioSchema for Holdout Tag
```typescript
// In scenario-schema.ts
export const ScenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(["orient", "decide", "verify", "coordinate", "handoff"]),
  tags: z.array(z.string()).default([]),
  holdout: z.boolean().default(false),  // NEW: holdout flag
  tool_calls: z.array(
    z.object({
      tool: z.string().startsWith("twining_"),
      arguments: z.record(z.unknown()).default({}),
    }),
  ).min(1),
  expected_scores: z.record(z.boolean()).default({}),
});
```

### Filtering Holdout in Scenario Loader
```typescript
// In scenario-loader.ts
export function loadScenarios(options?: { holdout?: boolean }): Scenario[] {
  const all = loadAllScenarios();
  if (options?.holdout === true) return all.filter(s => s.holdout === true);
  if (options?.holdout === false) return all.filter(s => s.holdout !== true);
  return all;  // default: all scenarios
}
```

### TUNING-LOG.md Entry Format
```markdown
## Tuning Entry: [N]

**Date:** 2026-03-0X
**Workflow batch:** orient
**Target failure:** Orient happy path / workflow-completeness score=0.8333

### Change
**File:** plugin/skills/twining-orient/SKILL.md
**What:** Added explicit instruction to call twining_status before twining_assemble
**Why:** Workflow completeness checks for status -> assemble -> decide chain

### Before
| Scenario | Scorer | Score | Passed |
|----------|--------|-------|--------|
| Orient happy path | workflow-completeness | 0.8333 | true |
| [others affected] | ... | ... | ... |

### After
| Scenario | Scorer | Score | Passed |
|----------|--------|-------|--------|
| Orient happy path | workflow-completeness | 1.0 | true |
| [others affected] | ... | ... | ... |

### Regression check
Full suite: [X]/198 passed (no regression)
```

### Regression Baseline Script
```typescript
// regression-baseline.ts (or inline in eval-runner afterAll)
interface RegressionBaseline {
  version: string;
  timestamp: string;
  plugin_version: string;
  thresholds: Record<string, number>;
  token_budget: {
    pre_tuning_bytes: number;
    post_tuning_bytes: number;
    growth_percent: number;
    cap_bytes: number;
  };
  aggregate: {
    synthetic_pass_rate: number;
    synthetic_overall_score: number;
    transcript_pass_rate: number;
    transcript_overall_score: number;
  };
  scenarios: Array<{
    name: string;
    category: string;
    tags: string[];
    holdout: boolean;
    scores: Record<string, {
      score: number;
      passed: boolean;
      threshold: number;
      checks_passed: number;
      checks_total: number;
    }>;
  }>;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| DEFAULT_THRESHOLD=0.8 for all | Per-scorer tiered thresholds | Phase 19 (planned) | Enables different strictness for core vs quality scorers |
| All scenarios in single pool | Training + holdout split | Phase 19 (planned) | Goodhart's Law mitigation via unseen scenario validation |
| Ad-hoc plugin changes | TUNING-LOG.md traceability | Phase 19 (planned) | Every change maps to a specific failure with before/after |

**Current baseline:**
- 34,838 bytes total across 13 plugin artifacts
- ~8,710 estimated tokens (bytes/4)
- 120% cap = 41,806 bytes / ~10,452 tokens
- Budget headroom: ~6,968 bytes (~1,742 tokens)

## Open Questions

1. **Per-scorer threshold calibration**
   - What we know: Core scorers should be stricter, quality scorers more lenient
   - What's unclear: Exact threshold values that make happy-path scenarios pass while violations fail
   - Recommendation: Analyze score distributions from latest.json to find natural breakpoints. For each scorer, find the minimum score achieved by any happy-path scenario and set threshold just below that.

2. **Negative scenario classification completeness**
   - What we know: Scenarios with `tags: [violation]` are negative. Expected_scores with `false` values indicate expected failures.
   - What's unclear: Some scenarios (coordinate-minimal, orient-minimal, verify-incomplete) have low scores but aren't clearly tagged as violations vs edge cases
   - Recommendation: Review each ambiguous scenario during the first tuning wave and explicitly classify it

3. **Transcript eval threshold adjustment**
   - What we know: Current transcript threshold is 0.6, target is 80% pass rate, current overall is 0.6745
   - What's unclear: Whether plugin tuning (which modifies instructions, not the transcript fixtures) will improve transcript scores
   - Recommendation: Transcript scores may not improve from skill tuning since transcripts are historical. Focus on 80% transcript target being met by current or adjusted thresholds rather than expecting plugin changes to affect recorded transcripts.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all 13 files in `test/eval/scorers/`, `test/eval/eval-runner.eval.ts`, `test/eval/transcript-runner.transcript.ts`
- Direct analysis of `test/eval/results/latest.json` (22 scenarios, 198 scorer-scenario pairs, 39 failures)
- Direct analysis of `test/eval/results/transcript-latest.json` (2 fixtures, overall score 0.6745)
- Direct analysis of all 13 plugin artifacts (8 skills, 2 agents, 2 hooks + config)
- All 22 YAML scenario files examined for expected_scores and tags

### Secondary (MEDIUM confidence)
- Token budget estimation using bytes/4 approximation (industry standard rough estimate for English text)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new libraries needed, all infrastructure exists
- Architecture: HIGH - patterns directly informed by codebase analysis
- Pitfalls: HIGH - failure analysis based on actual eval results, not hypothetical
- Threshold calibration: MEDIUM - exact values need empirical tuning during implementation

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable -- no external dependencies changing)
