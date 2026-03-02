# Phase 18: LLM-as-Judge Integration - Research

**Researched:** 2026-03-02
**Domain:** LLM-as-judge evaluation with Anthropic SDK, structured tool_use, consensus scoring
**Confidence:** HIGH

## Summary

Phase 18 adds two LLM-based scorers (rationale quality, scope appropriateness) to the existing eval pipeline. The key technical decisions are already locked: use `@anthropic-ai/sdk` with structured `tool_use` responses, default to Haiku, gate behind `TWINING_EVAL_JUDGE=1`, and run k>=3 parallel trials with majority consensus.

The existing eval architecture is well-suited for this. The `Scorer` interface needs to become async (`score()` returning `Promise<ScorerResult>`), which is a mechanical change -- deterministic scorers wrap their return in `Promise.resolve()`. The `allScorers` registry in `test/eval/scorers/index.ts` conditionally includes LLM scorers based on the env var. Both runners (`eval-runner.eval.ts` and `transcript-runner.transcript.ts`) need `await` on `scorer.score()` calls.

The Anthropic SDK's `tool_choice: { type: "tool", name: "judge_result" }` pattern guarantees structured JSON output without parsing ambiguity. The judge defines a tool whose `input_schema` matches the desired response format (score level + rationale), and Claude is forced to "call" that tool, producing guaranteed-parseable structured data. This is the standard pattern for extracting structured output from Claude and avoids fragile text parsing.

**Primary recommendation:** Build a thin `judge.ts` wrapper around `@anthropic-ai/sdk` that takes a criterion name + context, constructs a focused prompt with BEHAVIORS.md rubric levels, forces a structured tool response, and returns a normalized score. LLM scorers compose this wrapper with parallel k-trial consensus logic.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Use `@anthropic-ai/sdk` (new dependency) -- direct programmatic API with structured responses
- Default model: Haiku, configurable via `TWINING_EVAL_MODEL` env var
- API key: standard `ANTHROPIC_API_KEY` env var (skip gracefully if not set)
- Judge responses use structured tool_use -- define a tool schema the judge "calls" to return score + rationale, guaranteed parseable
- Rubric-graded scoring: feed the judge BEHAVIORS.md quality levels (good/acceptable/bad) as a rubric, judge picks a level + explains why, levels map to numeric scores
- Context per call: relevant tool call(s) with arguments and results, plus scenario metadata (category, description) -- not the full sequence
- Rationale quality scorer: evaluates `rationale` and `context` arguments in `twining_decide` calls
- Scope appropriateness scorer: evaluates whether scope arguments are appropriately narrow for the task
- Default k=3 trials, configurable via `TWINING_EVAL_TRIALS` env var
- All k trials fire in parallel (Promise.all) for fast wall-clock time
- Consensus: 2/3 majority agreement; when trials don't reach consensus, use median score
- Report disagreement in output (agreement ratio like "3/3 agreed" or "2/3 majority")
- LLM scorers integrate conditionally into existing runners -- not a separate vitest file
- Runners check `TWINING_EVAL_JUDGE=1` and skip LLM scorers when not set
- `Scorer.score()` becomes async (returns `Promise<ScorerResult>`) -- deterministic scorers wrap in `Promise.resolve()`
- `ScorerResult` gets optional `type: 'deterministic' | 'llm'` field for provenance
- API errors/timeouts produce warnings and skip the LLM scorer for that scenario

### Claude's Discretion
- Exact judge prompt wording and rubric formatting
- Tool schema design for structured responses
- How to extract relevant tool calls per scorer (which calls to feed to which judge)
- Error retry logic within the SDK wrapper
- How to map rubric levels to numeric 0-1 scores

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EVAL-03 | 2 LLM-as-judge scorers evaluate semantic quality (rationale specificity, scope appropriateness) | SDK wrapper + structured tool_use pattern, rubric from BEHAVIORS.md QualityCriterion levels, two scorer implementations following existing Scorer interface |
| EVAL-06 | LLM judge behind TWINING_EVAL_JUDGE=1 env-var gate, local-only | Conditional scorer registration in `scorers/index.ts`, env check in runners, graceful skip when API key missing |
| EVAL-07 | Multiple trials (k>=3) for non-deterministic scenarios | Parallel Promise.all with k trials, majority-vote consensus, median fallback, agreement ratio reporting |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | ^0.78.0 | Anthropic API client | Official TypeScript SDK, direct structured tool_use support, auto-reads ANTHROPIC_API_KEY |

### Supporting (already in project)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^3.25.0 | Schema validation | Already used project-wide; NOT needed for SDK tool schemas (those use JSON Schema directly) |
| `vitest` | ^4.0.18 | Test runner | Existing eval harness runner |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@anthropic-ai/sdk` | `ai` (Vercel AI SDK) | Locked decision -- user chose direct SDK for minimal abstraction |
| Structured tool_use | Text parsing with JSON mode | tool_use guarantees parseable output; text parsing is fragile |
| Haiku default | Sonnet/Opus | Haiku is cheapest and fastest; configurable via env var for users who want more capable models |

**Installation:**
```bash
npm install --save-dev @anthropic-ai/sdk
```

Note: Install as devDependency since it is only used in eval tests, never in production MCP server code.

## Architecture Patterns

### Recommended Project Structure
```
test/eval/
  judge.ts                 # SDK wrapper: createJudge(), callJudge(), consensusScore()
  scorers/
    index.ts               # Modified: conditionally includes LLM scorers
    rationale-judge.ts     # LLM scorer: rationale quality
    scope-judge.ts         # LLM scorer: scope appropriateness
    (existing 7 scorers)
  scorer-types.ts          # Modified: Scorer.score() -> async, ScorerResult.type field
  eval-runner.eval.ts      # Modified: await scorer.score(), env-var gating
  transcript-runner.transcript.ts  # Modified: same async + gating changes
```

### Pattern 1: Structured Tool Response for Judge Output
**What:** Define a tool schema that forces Claude to return structured evaluation data.
**When to use:** Every judge call -- guarantees parseable output without text extraction.
**Example:**
```typescript
// Source: Anthropic tool_use docs (https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview)
const JUDGE_TOOL = {
  name: "judge_result",
  description: "Report your evaluation of the tool call quality",
  input_schema: {
    type: "object" as const,
    properties: {
      level: {
        type: "string",
        enum: ["good", "acceptable", "bad"],
        description: "Quality level based on the rubric provided",
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of why this level was chosen",
      },
    },
    required: ["level", "reasoning"],
  },
};

// Force the tool with tool_choice
const response = await client.messages.create({
  model: process.env.TWINING_EVAL_MODEL ?? "claude-haiku-4-5-20250929",
  max_tokens: 512,
  tool_choice: { type: "tool", name: "judge_result" },
  tools: [JUDGE_TOOL],
  messages: [{ role: "user", content: prompt }],
});

// Extract structured result -- guaranteed to be tool_use block
const toolBlock = response.content.find((b) => b.type === "tool_use");
const input = toolBlock.input as { level: string; reasoning: string };
```

### Pattern 2: Parallel k-Trial Consensus
**What:** Fire k independent judge calls in parallel, aggregate via majority vote.
**When to use:** Every LLM scorer evaluation for reliability.
**Example:**
```typescript
async function consensusScore(
  judgeFn: () => Promise<JudgeResult>,
  k: number = 3,
): Promise<ConsensusResult> {
  const trials = await Promise.all(
    Array.from({ length: k }, () => judgeFn()),
  );

  // Count level occurrences
  const counts = new Map<string, number>();
  for (const t of trials) {
    counts.set(t.level, (counts.get(t.level) ?? 0) + 1);
  }

  // Find majority (>= ceil(k/2))
  const majority = Math.ceil(k / 2);
  let consensusLevel: string | undefined;
  for (const [level, count] of counts) {
    if (count >= majority) {
      consensusLevel = level;
      break;
    }
  }

  // Map level to score
  const scores = trials.map((t) => levelToScore(t.level));
  const finalScore = consensusLevel
    ? levelToScore(consensusLevel)
    : median(scores); // No majority -> median fallback

  const agreementCount = consensusLevel
    ? counts.get(consensusLevel)!
    : Math.max(...counts.values());

  return {
    score: finalScore,
    level: consensusLevel ?? "no-consensus",
    agreement: `${agreementCount}/${k}`,
    trials,
  };
}
```

### Pattern 3: Async Scorer Interface
**What:** Make `Scorer.score()` return `Promise<ScorerResult>`.
**When to use:** Required for LLM scorers; deterministic scorers trivially wrap.
**Example:**
```typescript
// Updated Scorer interface
export interface Scorer {
  name: string;
  score(input: ScorerInput, spec: BehaviorSpec): Promise<ScorerResult>;
}

// Deterministic scorer -- minimal change (add async keyword)
export const scopeQualityScorer: Scorer = {
  name: "scope-quality",
  async score(input: ScorerInput, _spec: BehaviorSpec): Promise<ScorerResult> {
    // ... existing synchronous logic unchanged ...
    return { scorer: this.name, score, passed: score >= DEFAULT_THRESHOLD, checks };
  },
};
```

### Pattern 4: Conditional Scorer Registration
**What:** LLM scorers only added to `allScorers` when `TWINING_EVAL_JUDGE=1`.
**When to use:** Scorer registry in `scorers/index.ts`.
**Example:**
```typescript
import { rationaleJudgeScorer } from "./rationale-judge.js";
import { scopeJudgeScorer } from "./scope-judge.js";

export const deterministicScorers: Scorer[] = [
  sequencingScorer, scopeQualityScorer, argumentQualityScorer,
  decisionHygieneScorer, workflowCompletenessScorer,
  antiPatternsScorer, qualityCriteriaScorer,
];

export const llmScorers: Scorer[] = [
  rationaleJudgeScorer,
  scopeJudgeScorer,
];

export const allScorers: Scorer[] = process.env.TWINING_EVAL_JUDGE === "1"
  ? [...deterministicScorers, ...llmScorers]
  : deterministicScorers;
```

### Anti-Patterns to Avoid
- **Monolithic judge prompts:** Never send the entire tool call sequence to a single judge call. Each criterion gets its own focused call with only the relevant tool calls.
- **Parsing free-text judge output:** Always use `tool_choice: { type: "tool", name: "judge_result" }` to force structured output. Never regex-parse natural language for scores.
- **Blocking CI on LLM judge:** LLM scorers MUST be behind the env-var gate. The eval suite runs deterministic-only in CI by default.
- **Failing hard on API errors:** SDK timeouts, rate limits, or missing API key should produce warnings and skip, not fail the test suite.
- **Sequential k trials:** All k trials should fire in parallel via `Promise.all` for wall-clock speed. They are independent.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Anthropic API communication | HTTP client with manual auth | `@anthropic-ai/sdk` | Handles auth, retries, types, streaming, error classes |
| Structured output extraction | JSON parsing of free-text | `tool_choice` forced tool_use | Guaranteed schema-conformant output from the API |
| Response type checking | Manual `typeof` checks | SDK TypeScript types (`ContentBlock`, `ToolUseBlock`) | Full type safety with `content.find(b => b.type === 'tool_use')` |

**Key insight:** The Anthropic SDK + forced tool_use pattern eliminates the entire class of "parse LLM output" problems. The response is guaranteed to contain a `tool_use` block with typed `input` matching the defined schema.

## Common Pitfalls

### Pitfall 1: Model String Mismatch
**What goes wrong:** Using outdated or incorrect model identifiers (e.g., `claude-3-haiku-20240307` instead of current Haiku).
**Why it happens:** Model IDs change with new releases and old ones get deprecated.
**How to avoid:** Default to a current model ID but make it configurable via `TWINING_EVAL_MODEL`. Current Haiku: `claude-haiku-4-5-20250929`. Check the pricing table in official docs for latest IDs.
**Warning signs:** API returns 404 or "model not found" error.

### Pitfall 2: Missing API Key Fails the Whole Suite
**What goes wrong:** If `ANTHROPIC_API_KEY` is not set and LLM judge is enabled, the SDK constructor throws immediately.
**Why it happens:** The Anthropic client constructor reads the key from environment and throws if missing.
**How to avoid:** Check for `ANTHROPIC_API_KEY` before constructing the client. If missing, log a warning and return a skip/vacuous result. Dual gate: `TWINING_EVAL_JUDGE=1` AND `ANTHROPIC_API_KEY` present.
**Warning signs:** `AuthenticationError` at module import time.

### Pitfall 3: Async Scorer Breaks Existing Sync Runner Loops
**What goes wrong:** Changing `Scorer.score()` to return `Promise<ScorerResult>` means existing `for (const scorer of allScorers)` loops need `await`.
**Why it happens:** TypeScript won't error on a missing `await` for Promise if the return value is used loosely.
**How to avoid:** Make the change mechanical: add `async` keyword to all existing scorer `score()` methods, add `await` to all call sites in both runners. The runners already use `it()` callbacks which vitest supports as async.
**Warning signs:** Tests getting `[object Promise]` instead of ScorerResult values; assertions against undefined fields.

### Pitfall 4: tool_use Block Not Found in Response
**What goes wrong:** When using `tool_choice: { type: "tool" }`, the response should always contain a `tool_use` block, but edge cases (rate limits, content filtering) may return something else.
**Why it happens:** API errors can return non-standard content blocks.
**How to avoid:** Always find the tool_use block defensively: `response.content.find(b => b.type === 'tool_use')`. If not found, treat as an error/skip.
**Warning signs:** `TypeError: Cannot read properties of undefined`.

### Pitfall 5: Non-Deterministic Test Assertions
**What goes wrong:** LLM judge returns different scores across runs, causing flaky test failures.
**Why it happens:** LLM output is inherently non-deterministic even at low temperature.
**How to avoid:** The k-trial consensus mechanism handles this. Assert on consensus results, not individual trials. Use `temperature: 0` in judge calls to reduce (not eliminate) variability.
**Warning signs:** Tests that pass on one run and fail on the next with the same inputs.

### Pitfall 6: Vitest Timeout on Parallel API Calls
**What goes wrong:** k=3 parallel API calls exceed vitest's default test timeout.
**Why it happens:** Each API call takes 1-5 seconds; 3 parallel calls still take up to 5 seconds plus overhead.
**How to avoid:** The existing vitest eval configs use `testTimeout: 30000` which is sufficient. LLM scorer tests may need slightly longer, but 30s should cover k=3 parallel Haiku calls.
**Warning signs:** Test timeout errors only on LLM scorer tests.

## Code Examples

### Judge Module Core (`judge.ts`)
```typescript
// Source: Anthropic SDK docs + tool_choice pattern
import Anthropic from "@anthropic-ai/sdk";
import type { QualityCriterion } from "./types.js";

export interface JudgeResult {
  level: string;
  reasoning: string;
}

export interface ConsensusResult {
  score: number;
  level: string;
  agreement: string;
  trials: JudgeResult[];
}

const LEVEL_SCORES: Record<string, number> = {
  good: 1.0,
  acceptable: 0.5,
  bad: 0.0,
};

function levelToScore(level: string): number {
  return LEVEL_SCORES[level] ?? 0.0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

const JUDGE_TOOL = {
  name: "judge_result",
  description: "Report your quality evaluation",
  input_schema: {
    type: "object" as const,
    properties: {
      level: {
        type: "string",
        enum: ["good", "acceptable", "bad"],
        description: "Quality level from the rubric",
      },
      reasoning: {
        type: "string",
        description: "Why this level was chosen",
      },
    },
    required: ["level", "reasoning"],
  },
};

export function createJudgeClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic(); // reads ANTHROPIC_API_KEY automatically
}

export async function callJudge(
  client: Anthropic,
  prompt: string,
): Promise<JudgeResult> {
  const model = process.env.TWINING_EVAL_MODEL ?? "claude-haiku-4-5-20250929";
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    temperature: 0,
    tool_choice: { type: "tool", name: "judge_result" },
    tools: [JUDGE_TOOL],
    messages: [{ role: "user", content: prompt }],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Judge did not return tool_use block");
  }

  const input = toolBlock.input as { level: string; reasoning: string };
  return { level: input.level, reasoning: input.reasoning };
}
```

### Rubric Prompt Construction
```typescript
export function buildRubricPrompt(
  criterion: QualityCriterion,
  context: string,
): string {
  const rubricLines = criterion.levels
    .map((l) => `- **${l.level}**: ${l.description}\n  Example: ${l.example}`)
    .join("\n");

  return `You are evaluating the quality of an AI agent's tool usage.

## Criterion: ${criterion.name}

## Rubric
${rubricLines}

## Tool Call to Evaluate
${context}

Evaluate the tool call against the rubric above. Pick the quality level that best matches and explain your reasoning.`;
}
```

### Runner Async Migration
```typescript
// In eval-runner.eval.ts -- the key change is adding `await`
for (const scorer of allScorers) {
  it(`${scorer.name}`, async () => {
    const input = normalizeScenario(scenario);
    const result = await scorer.score(input, spec); // was: scorer.score(input, spec)
    // ... rest unchanged
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Text output + regex parsing | `tool_choice` forced structured output | 2024+ | Eliminates parse failures entirely |
| Single LLM judge call | k-trial consensus with majority vote | 2024-2025 best practices | Handles non-determinism, quantifies reliability |
| Monolithic evaluation prompts | One criterion per judge call | 2024-2025 research | Better accuracy, clearer rubric alignment |
| Claude 3 Haiku | Claude Haiku 4.5 | 2025 | Faster, cheaper, better instruction following |

**Deprecated/outdated:**
- `claude-3-haiku-20240307`: Deprecated. Use `claude-haiku-4-5-20250929` as default.
- Free-text JSON mode: Replaced by forced tool_use for guaranteed structure.
- `betaZodTool` helper: Available but unnecessary for this use case -- raw tool schema is simpler and avoids beta API dependency.

## Open Questions

1. **Exact Haiku 4.5 model string**
   - What we know: The pricing table lists "Claude Haiku 4.5" with tool_choice support. The SDK README shows model strings like `claude-sonnet-4-5-20250929`.
   - What's unclear: Whether `claude-haiku-4-5-20250929` is the exact current string or if a newer date suffix exists.
   - Recommendation: Use `claude-haiku-4-5-20250929` as default; the `TWINING_EVAL_MODEL` env var lets users override if needed. Can verify at implementation time with a smoke test.

2. **Temperature parameter interaction with tool_choice**
   - What we know: `temperature: 0` reduces randomness. `tool_choice: { type: "tool" }` forces tool use.
   - What's unclear: Whether temperature=0 with forced tool_choice produces fully deterministic output.
   - Recommendation: Use `temperature: 0` but still run k trials. Even at temperature 0, minor non-determinism can exist. The consensus mechanism handles this.

## Sources

### Primary (HIGH confidence)
- Anthropic official docs: tool_use overview (https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview) -- tool schema format, tool_choice options, TypeScript examples, response structure, pricing
- Anthropic SDK GitHub (https://github.com/anthropics/anthropic-sdk-typescript) -- installation, client instantiation, message creation, TypeScript types
- npm @anthropic-ai/sdk v0.78.0 (https://www.npmjs.com/package/@anthropic-ai/sdk) -- latest version, package size

### Secondary (MEDIUM confidence)
- Anthropic tool_choice cookbook (https://platform.claude.com/cookbook/tool-use-tool-choice) -- tool_choice: auto/any/tool patterns, forced tool examples
- LLM-as-judge guide (https://www.evidentlyai.com/llm-guide/llm-as-a-judge) -- rubric design, binary vs ordinal scoring, handling non-determinism, common biases
- Anthropic structured outputs docs (https://platform.claude.com/docs/en/build-with-claude/structured-outputs) -- strict:true option for guaranteed schema conformance

### Tertiary (LOW confidence)
- Haiku 4.5 model string: Inferred from SDK README patterns; needs implementation-time verification

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official SDK, well-documented API, locked user decision
- Architecture: HIGH - Pattern follows existing scorer structure closely, tool_use is standard Anthropic pattern
- Pitfalls: HIGH - Based on SDK documentation, real API behavior, and existing codebase analysis
- Judge prompt design: MEDIUM - Best practices from LLM-as-judge literature, but exact prompt wording needs empirical tuning

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (SDK version and model strings may update; patterns are stable)
