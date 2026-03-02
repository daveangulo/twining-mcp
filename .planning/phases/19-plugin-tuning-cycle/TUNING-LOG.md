# Tuning Log - Phase 19

## Pre-Tuning Baseline

**Date:** 2026-03-02
**Eval results:** 22 scenarios x 9 scorers = 198 pairs; 157/198 passed with per-scorer thresholds (79.3%), overall score: 0.8998
**Token budget:** 34,838 bytes (~8,710 tokens), cap: 41,806 bytes (+20%)
**Thresholds:** sequencing=0.9, decision-hygiene=0.9, anti-patterns=0.9, workflow-completeness=0.8, scope-quality=0.7, argument-quality=0.7, quality-criteria=0.7, rationale-judge=0.5, scope-judge=0.5

## Failure Classification

Total failures with per-scorer thresholds: 41

### Expected Negatives (Scorer Correctly Detecting Violations)

These are violation/negative-test scenarios where scorers correctly detect bad behavior. No plugin tuning needed.

| Scenario | Tags | Scorer | Score | Threshold | Classification |
|----------|------|--------|-------|-----------|----------------|
| Cross-cutting anti-pattern combo | violation | sequencing | 0.6667 | 0.9 | Expected: scenario deliberately combines multiple anti-patterns |
| Cross-cutting anti-pattern combo | violation | scope-quality | 0.5 | 0.7 | Expected: broad scope is intentional anti-pattern |
| Cross-cutting anti-pattern combo | violation | argument-quality | 0.6667 | 0.7 | Expected: poor arguments are intentional |
| Cross-cutting anti-pattern combo | violation | decision-hygiene | 0.1667 | 0.9 | Expected: minimal rationale, no prior assemble |
| Cross-cutting anti-pattern combo | violation | anti-patterns | 0.6 | 0.9 | Expected: scenario triggers multiple anti-patterns |
| Cross-cutting anti-pattern combo | violation | quality-criteria | 0.625 | 0.7 | Expected: poor quality is intentional |
| Decide blind | violation | decision-hygiene | 0.6667 | 0.9 | Expected: blind decision without assemble |
| Decide fire and forget | violation | scope-quality | 0.5 | 0.7 | Expected: broad scope in fire-and-forget pattern |
| Decide fire and forget | violation | argument-quality | 0.0 | 0.7 | Expected: missing arguments in fire-and-forget |
| Decide fire and forget | violation | decision-hygiene | 0.5 | 0.9 | Expected: incomplete decision hygiene |
| Decide fire and forget | violation | anti-patterns | 0.7 | 0.9 | Expected: fire-and-forget anti-pattern detected |
| Decide fire and forget | violation | quality-criteria | 0.625 | 0.7 | Expected: poor quality in fire-and-forget |
| Decide without alternatives | violation | argument-quality | 0.5 | 0.7 | Expected: missing alternatives is argument gap |
| Decide without alternatives | violation | decision-hygiene | 0.6667 | 0.9 | Expected: missing alternatives violates hygiene |
| Decide without rationale | violation | scope-quality | 0.5 | 0.7 | Expected: broad scope with missing rationale |
| Decide without rationale | violation | argument-quality | 0.5 | 0.7 | Expected: empty rationale fails argument quality |
| Decide without rationale | violation | anti-patterns | 0.7 | 0.9 | Expected: rationale poverty anti-pattern |
| Decide without rationale | violation | quality-criteria | 0.625 | 0.7 | Expected: poor quality from missing rationale |
| Handoff inaccurate status | violation | argument-quality | 0.0 | 0.7 | Expected: inaccurate status is argument failure |
| Handoff inaccurate status | violation | decision-hygiene | 0.1667 | 0.9 | Expected: inaccurate handoff lacks hygiene |
| Handoff inaccurate status | violation | workflow-completeness | 0.75 | 0.8 | Expected: incomplete workflow with inaccurate status |
| Handoff inaccurate status | violation | anti-patterns | 0.7 | 0.9 | Expected: inaccurate status triggers anti-patterns |
| Handoff without verify | violation | sequencing | 0.75 | 0.9 | Expected: missing verify step breaks sequence |
| Handoff without verify | violation | workflow-completeness | 0.75 | 0.8 | Expected: skipping verify makes workflow incomplete |
| Orient broad scope | violation | scope-quality | 0.5 | 0.7 | Expected: broad scope is the violation being tested |
| Orient broad scope | violation | quality-criteria | 0.5 | 0.7 | Expected: broad scope fails quality criteria |
| Orient skips assemble | violation | argument-quality | 0.0 | 0.7 | Expected: skipping assemble means bad arguments downstream |
| Orient skips assemble | violation | decision-hygiene | 0.1667 | 0.9 | Expected: no assemble means poor decision hygiene |
| Orient skips assemble | violation | workflow-completeness | 0.5 | 0.8 | Expected: missing assemble makes workflow incomplete |
| Orient skips assemble | violation | anti-patterns | 0.7 | 0.9 | Expected: skipping assemble is anti-pattern |
| Orient skips assemble | violation | quality-criteria | 0.6667 | 0.7 | Expected: quality suffers without assemble |
| Verify early complete | violation | sequencing | 0.5 | 0.9 | Expected: early complete breaks verify sequence |
| Verify incomplete | violation | workflow-completeness | 0.5 | 0.8 | Expected: incomplete verify workflow |
| Coordinate without capability check | violation | sequencing | 0.5 | 0.9 | Expected: missing capability check breaks coordination sequence |

**Total expected negatives: 34**

### Unexpected Failures (Needs Investigation)

These are happy-path or edge-case scenarios where a scorer fails unexpectedly, indicating either a plugin gap, threshold issue, or scorer sensitivity.

| Scenario | Tags | Scorer | Score | Threshold | Analysis | Action |
|----------|------|--------|-------|-----------|----------|--------|
| Coordinate minimal | happy-path, minimal | workflow-completeness | 0.5 | 0.8 | Minimal coordinate scenario (just twining_delegate) lacks expected workflow steps. Score correctly reflects incomplete workflow. | Threshold OK; scenario tests minimal behavior -- failure is expected for a minimal happy-path |
| Cross-cutting full lifecycle | happy-path, full-lifecycle | sequencing | 0.75 | 0.9 | Cross-cutting scenario spans orient+decide+verify+handoff. Sequencing scorer checks per-workflow ordering but cross-cutting flows have inherently mixed ordering. | Known limitation: cross-cutting scenarios cannot assert strict per-workflow sequencing. No plugin change needed. |
| Decide without rationale | violation | decision-hygiene | 0.8333 | 0.9 | Score is 0.8333, just below 0.9 threshold. Scenario is tagged violation but decision-hygiene wasn't in expected_scores=false. Only 1 of 3 hygiene checks fails -- the rationale check passes because rationale IS provided (just poor quality). | Edge case: scorer correctly detects partial violation. Threshold working as designed. |
| Handoff inaccurate status | violation | sequencing | 0.8333 | 0.9 | Score 0.8333 just below 0.9. Scenario is a violation but sequencing wasn't in expected_scores=false. Minor ordering issue in an otherwise well-sequenced violation scenario. | Edge case: stricter threshold catches borderline sequence issue in violation scenario. Expected negative, recategorize. |
| Orient minimal | happy-path, minimal | workflow-completeness | 0.5 | 0.8 | Minimal orient scenario (just twining_assemble) lacks status/post steps. Score correctly reflects incomplete orient workflow. | Threshold OK; minimal happy-path lacks workflow completeness by design |
| Verify happy path | happy-path | sequencing | 0.875 | 0.9 | Verify scenario has 4 tool calls. Sequencing checks 4 ordering rules, 3 pass. Score 0.875 is just below 0.9 threshold. | Investigate in Plan 19-02: which ordering rule fails? May need plugin BEHAVIORS.md tuning for verify workflow ordering. |
| Verify happy path | happy-path | workflow-completeness | 0.6667 | 0.8 | Verify happy path misses 1 of 3 completeness checks. Likely missing twining_assemble before verify. | Investigate in Plan 19-02: verify workflow definition may need updating to not require assemble for standalone verify. |

**Total unexpected failures: 7**

### Reclassified (Initially Ambiguous)

After analysis, reclassified "Handoff inaccurate status/sequencing" from unexpected to expected negative (violation scenario, borderline score).

**Final counts: 35 expected negatives, 6 unexpected failures, 41 total**

## Threshold Analysis

Score distribution across happy-path scenarios (scores for each scorer):

### sequencing (threshold: 0.9)
- Coordinate happy path: 1.0
- Cross-cutting full lifecycle: 0.75 (cross-cutting, known limitation)
- Decide happy path: 1.0
- Handoff happy path: 1.0
- Orient happy path: 1.0
- Verify happy path: 0.875 (borderline -- investigate)
- **Conclusion:** 0.9 threshold is appropriate; 4/6 true happy-paths pass cleanly. 2 edge cases need investigation.

### decision-hygiene (threshold: 0.9)
- Coordinate happy path: 1.0
- Cross-cutting full lifecycle: 1.0
- Decide happy path: 1.0
- Handoff happy path: 1.0
- Orient happy path: 1.0
- Verify happy path: 1.0
- **Conclusion:** All happy-paths pass at 0.9. Threshold well-calibrated.

### anti-patterns (threshold: 0.9)
- Coordinate happy path: 1.0
- Cross-cutting full lifecycle: 1.0
- Decide happy path: 1.0
- Handoff happy path: 1.0
- Orient happy path: 1.0
- Verify happy path: 1.0
- **Conclusion:** All happy-paths pass at 0.9. Threshold well-calibrated.

### workflow-completeness (threshold: 0.8)
- Coordinate happy path: 1.0
- Coordinate minimal: 0.5 (minimal scenario, expected gap)
- Cross-cutting full lifecycle: 0.9167
- Decide happy path: 1.0
- Handoff happy path: 0.8333
- Orient happy path: 0.8333
- Orient minimal: 0.5 (minimal scenario, expected gap)
- Verify happy path: 0.6667 (investigate)
- **Conclusion:** 0.8 threshold is appropriate for full happy-paths. Minimal scenarios naturally fail. Verify happy path needs investigation.

### scope-quality (threshold: 0.7)
- All happy-paths score 1.0
- **Conclusion:** 0.7 threshold well-calibrated.

### argument-quality (threshold: 0.7)
- All happy-paths score 1.0
- **Conclusion:** 0.7 threshold well-calibrated.

### quality-criteria (threshold: 0.7)
- All happy-paths score 1.0
- **Conclusion:** 0.7 threshold well-calibrated.

### rationale-judge / scope-judge (threshold: 0.5)
- All scenarios pass (LLM scorers return 1.0 when not invoked)
- **Conclusion:** Advisory thresholds working as designed.

## Tuning Entries

*Entries will be added during Plan 19-02 as plugin changes are made.*

| # | Date | Change | Scorer Target | Files Modified | Token Delta | Result |
|---|------|--------|---------------|----------------|-------------|--------|
| | | | | | | |
