---
phase: 18-llm-as-judge-integration
verified: 2026-03-02T18:30:00Z
status: passed
score: 11/11 must-haves verified
re_verification: false
---

# Phase 18: LLM-as-Judge Integration Verification Report

**Phase Goal:** Qualitative aspects that deterministic scorers cannot check (rationale specificity, scope appropriateness) are evaluated by an LLM judge, gated behind an env var so they never run in CI
**Verified:** 2026-03-02T18:30:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Scorer.score() returns Promise<ScorerResult> and all callers await it | VERIFIED | scorer-types.ts line 55: `score(input: ScorerInput, spec: BehaviorSpec): Promise<ScorerResult>` — both runners await at eval-runner.eval.ts:57 and transcript-runner.transcript.ts:117 |
| 2 | allScorers conditionally includes LLM scorers only when TWINING_EVAL_JUDGE=1 | VERIFIED | scorers/index.ts:35-38: ternary on `process.env.TWINING_EVAL_JUDGE === "1"` — TWINING_EVAL_JUDGE absent from .github/ CI workflows |
| 3 | Eval suite runs deterministic-only by default (no env var set) | VERIFIED | Without env var, allScorers = deterministicScorers (7 scorers). llmScorers array populated but only included when gated env var is "1" |
| 4 | judge.ts wraps Anthropic SDK with structured tool_use and k-trial consensus | VERIFIED | judge.ts lines 140-165: `tool_choice: { type: "tool", name: "judge_result" }`, `tool_use` block extracted defensively. Lines 185-245: k-trial parallel Promise.all with majority voting + median fallback |
| 5 | Missing ANTHROPIC_API_KEY produces graceful skip, not crash | VERIFIED | judge.ts:113-116: `createJudgeClient()` returns null when env var unset. Both LLM scorers check for null client and return vacuous pass with skip message |
| 6 | Rationale quality scorer evaluates twining_decide calls' rationale/context via LLM judge | VERIFIED | rationale-judge.ts:78 filters to `twining_decide` calls, builds prompt via `buildRubricPrompt`, calls `consensusScore(() => callJudge(client, prompt))` |
| 7 | Scope appropriateness scorer evaluates scope arguments via LLM judge | VERIFIED | scope-judge.ts:95-96 filters calls with `typeof c.arguments["scope"] === "string"`, builds scope context, calls consensusScore |
| 8 | Both scorers use k-trial consensus with majority vote | VERIFIED | Both call `consensusScore()` which runs k parallel trials (default 3), finds majority >= ceil(k/2), falls back to median |
| 9 | Both scorers gracefully skip when API key is missing or API errors occur | VERIFIED | Both check `createJudgeClient()` null (skip on missing key) and wrap scoring loop in try/catch with console.warn + vacuous pass on error |
| 10 | Both scorers registered in allScorers when TWINING_EVAL_JUDGE=1 | VERIFIED | scorers/index.ts:30-33: `llmScorers = [rationaleJudgeScorer, scopeJudgeScorer]` — included in allScorers when env var "1" |
| 11 | Running eval without TWINING_EVAL_JUDGE=1 produces same results as before | VERIFIED | allScorers without env var = deterministicScorers only (7 scorers). Summary confirms 154 deterministic tests unchanged |

**Score:** 11/11 truths verified

---

## Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `test/eval/judge.ts` | VERIFIED | 288 lines, substantive. Exports: `JudgeResult`, `ConsensusResult`, `LEVEL_SCORES`, `JUDGE_TOOL`, `levelToScore`, `median`, `createJudgeClient`, `callJudge`, `consensusScore`, `buildRubricPrompt`. Imports Anthropic SDK at line 14. |
| `test/eval/scorer-types.ts` | VERIFIED | `Scorer.score()` returns `Promise<ScorerResult>` (line 55). `ScorerResult` has `type?: "deterministic" \| "llm"` (line 43). |
| `test/eval/scorers/index.ts` | VERIFIED | Contains `TWINING_EVAL_JUDGE` gating (line 36), `deterministicScorers` (7 entries), `llmScorers` (2 entries: rationaleJudgeScorer, scopeJudgeScorer), `allScorers` conditional. |
| `test/eval/scorers/rationale-judge.ts` | VERIFIED | 152 lines, substantive. Exports `rationaleJudgeScorer`. Handles: no criterion (vacuous pass), no decide calls (vacuous pass), no API key (skip message), API errors (warn + vacuous pass). |
| `test/eval/scorers/scope-judge.ts` | VERIFIED | 171 lines, substantive. Exports `scopeJudgeScorer`. Same resilience pattern as rationale-judge. |
| `package.json` (devDependency @anthropic-ai/sdk) | VERIFIED | `"@anthropic-ai/sdk": "^0.78.0"` present in devDependencies |
| All 7 deterministic scorers (async score) | VERIFIED | sequencing.ts, scope-quality.ts, argument-quality.ts, decision-hygiene.ts, workflow-completeness.ts, anti-patterns.ts, quality-criteria.ts all have `async score(...)` returning `Promise<ScorerResult>` |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `test/eval/judge.ts` | `@anthropic-ai/sdk` | `import Anthropic from` | WIRED | Line 14: `import Anthropic from "@anthropic-ai/sdk"` |
| `test/eval/scorers/index.ts` | `test/eval/judge.ts` | `TWINING_EVAL_JUDGE` conditional | WIRED | Line 36: `process.env.TWINING_EVAL_JUDGE === "1"` gates llmScorers inclusion |
| `test/eval/eval-runner.eval.ts` | `test/eval/scorers/index.ts` | `await scorer.score` | WIRED | Line 57: `const result = await scorer.score(input, spec)` |
| `test/eval/scorers/rationale-judge.ts` | `test/eval/judge.ts` | imports createJudgeClient, callJudge, consensusScore, buildRubricPrompt | WIRED | Lines 15-20: all 4 functions imported and used in score() body |
| `test/eval/scorers/scope-judge.ts` | `test/eval/judge.ts` | imports createJudgeClient, callJudge, consensusScore, buildRubricPrompt | WIRED | Lines 15-20: all 4 functions imported and used in score() body |
| `test/eval/scorers/index.ts` | `test/eval/scorers/rationale-judge.ts` | import rationaleJudgeScorer | WIRED | Line 16: `import { rationaleJudgeScorer } from "./rationale-judge.js"` — used in llmScorers array |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| EVAL-03 | 18-02 | 2 LLM-as-judge scorers evaluate semantic quality (rationale specificity, scope appropriateness) | SATISFIED | `rationale-judge.ts` evaluates twining_decide rationale/context; `scope-judge.ts` evaluates scope arguments. Both registered in llmScorers. |
| EVAL-06 | 18-01 | LLM judge behind TWINING_EVAL_JUDGE=1 env-var gate, local-only | SATISFIED | `allScorers` ternary at scorers/index.ts:35-38. TWINING_EVAL_JUDGE confirmed absent from .github/ CI workflows. |
| EVAL-07 | 18-01 & 18-02 | Multiple trials (k>=3) for non-deterministic scenarios | SATISFIED | `consensusScore()` in judge.ts reads `TWINING_EVAL_TRIALS` or defaults to `3`. Fires k trials in parallel via `Promise.all`. Both LLM scorers call consensusScore. |

No orphaned requirements — REQUIREMENTS.md maps only EVAL-03, EVAL-06, and EVAL-07 to Phase 18, and all three are accounted for in plans 18-01 and 18-02.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `test/eval/judge.ts` | 114 | `return null` | INFO | Legitimate safety gate — `createJudgeClient()` returns null when `ANTHROPIC_API_KEY` unset. This is the documented graceful degradation pattern, not an empty implementation. |

No blocker or warning anti-patterns found. The `return null` is the intended and documented API key safety gate.

---

## Human Verification Required

### 1. LLM Scorer Execution with Real API Key

**Test:** Set `ANTHROPIC_API_KEY=<key> TWINING_EVAL_JUDGE=1 npm run eval:synthetic` and observe output
**Expected:** 198 total tests run (154 deterministic + 44 LLM scorer tests). LLM scorer tests produce actual scored results (not all vacuous passes). Each rationale-judge and scope-judge test shows a level (good/acceptable/bad) with reasoning.
**Why human:** Requires a real Anthropic API key and live API call — cannot verify programmatically without credentials.

### 2. CI Isolation Confirmation

**Test:** Run `npm run eval:synthetic` and `npm run eval:transcript` in a clean environment without TWINING_EVAL_JUDGE set
**Expected:** Exactly 154 synthetic + 16 transcript tests pass. No LLM API calls made, no API key errors.
**Why human:** Behavioral confirmation that no LLM calls fire in the default path — grep confirms the code gate but runtime behavior needs confirmation.

---

## Commits Verified

All 4 task commits exist and touched the expected files:

- `45daf03` — feat(18-01): install Anthropic SDK and create judge.ts wrapper
- `a4c8484` — feat(18-01): make scorer interface async with conditional LLM scorer registry
- `eb37289` — feat(18-02): implement rationale-judge and scope-judge LLM scorers
- `aab9bc8` — feat(18-02): register LLM scorers in conditional scorer pipeline

---

## Summary

Phase 18 fully achieves its goal. The LLM judge infrastructure is complete and correctly wired:

1. **judge.ts** provides a real Anthropic SDK wrapper with structured `tool_use` (forced tool_choice), k-trial consensus scoring using majority vote with median fallback, and a safety gate (`createJudgeClient` returns null when no API key).

2. **rationale-judge.ts** and **scope-judge.ts** implement the full LLM scorer pattern: criterion lookup from spec, call filtering, API key gating, per-call consensus scoring, and try/catch graceful degradation.

3. **scorers/index.ts** gates LLM scorers behind `process.env.TWINING_EVAL_JUDGE === "1"` — the env var is confirmed absent from `.github/` CI workflows, meaning LLM scorers never run in CI.

4. All 7 deterministic scorers were migrated to async and both eval runners await `scorer.score()` — the async interface is consistent end-to-end.

5. Requirements EVAL-03, EVAL-06, and EVAL-07 are all satisfied with direct code evidence.

---

_Verified: 2026-03-02T18:30:00Z_
_Verifier: Claude (gsd-verifier)_
