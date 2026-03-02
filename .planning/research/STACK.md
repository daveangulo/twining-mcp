# Technology Stack: v1.4 Agent Behavior Quality

**Project:** Twining MCP Server -- Behavioral Evaluation Milestone
**Researched:** 2026-03-02

## Executive Summary

The v1.4 milestone needs three capabilities: (1) a behavioral spec format for defining correct tool usage, (2) a test harness for running evaluation scenarios, and (3) transcript analysis for real-world validation. The recommendation is to add **one new devDependency** (`vitest-evals`) and write the rest as custom TypeScript -- behavioral specs as Zod-validated YAML, transcript parsing as a bespoke module, and LLM-as-judge grading via the Anthropic SDK directly. Promptfoo is explicitly rejected as too heavy (21MB, 348 deps, Node >= 20 conflict).

## Recommended Stack

### New Dependencies

| Technology | Version | Purpose | Why | Dep Type |
|------------|---------|---------|-----|----------|
| `vitest-evals` | ^0.5.0 | Eval runner with scorer framework | Sentry's lightweight vitest extension; native vitest integration, ToolCallScorer built-in, custom scorer API returns 0-1 scores. Sits on top of existing vitest -- no new test runner. | devDependency |

### Existing Dependencies (Leveraged, No Changes)

| Technology | Current Version | New Purpose | Why |
|------------|----------------|-------------|-----|
| `vitest` | ^4.0.18 | Host for eval test suites | Already the test runner; vitest-evals extends it |
| `zod` | ^3.25.0 | Behavioral spec schema validation | Already used for all tool input schemas; natural choice for spec validation |
| `js-yaml` | ^4.1.0 | Parse behavioral spec YAML files | Already a dependency; YAML is human-writable for specs |
| `@modelcontextprotocol/sdk` | ^1.26.0 | Mock MCP server for scenario playback | Already used in integration tests via `createServer()` pattern |

### Custom Modules (Build, Don't Buy)

| Module | Purpose | Why Custom |
|--------|---------|------------|
| `src/eval/spec-loader.ts` | Load + validate behavioral YAML specs | Zod + js-yaml already available; spec format is Twining-specific |
| `src/eval/transcript-parser.ts` | Parse Claude Code JSONL transcripts | Simple line-by-line JSONL parsing; format is well-understood from existing stop-hook patterns |
| `src/eval/scorers/` | Custom scorer functions for vitest-evals | Behavioral criteria are domain-specific (tool sequence correctness, decision recording, scope usage) |
| `src/eval/judges/` | LLM-as-judge evaluation wrappers | Thin wrapper around Anthropic Messages API; no framework needed for simple grading prompts |
| `src/eval/scenarios/` | Test scenario definitions | YAML files defining input/expected-behavior pairs |

## Behavioral Spec Format

Use **YAML with Zod validation** because:
- Project already depends on `js-yaml` and `zod`
- YAML is human-readable and writable (specs are authored by humans, not generated)
- Zod provides TypeScript type inference from schemas -- specs become typed at compile time
- Same pattern as promptfoo's declarative configs but without the 21MB dependency

```yaml
# Example: behavioral-spec/tools/twining_decide.yaml
tool: twining_decide
description: "Record an architectural or implementation decision"

when_to_use:
  - "After making a significant choice that affects code structure"
  - "When choosing between alternatives (framework, pattern, approach)"
  - "Before implementing a design that future agents need to know about"

when_not_to_use:
  - "For trivial changes (rename variable, fix typo)"
  - "For decisions already recorded (check with twining_why first)"
  - "When the choice is dictated by existing constraints (no real alternative)"

required_fields:
  domain: "One of: architecture, implementation, testing, tooling, process"
  scope: "Narrowest path covering the affected area"
  rationale: "Must explain WHY, not just WHAT"

anti_patterns:
  - name: "empty_rationale"
    description: "Recording a decision without explaining why"
    example:
      rationale: "Because it's better"
    severity: critical

  - name: "scope_too_broad"
    description: "Using 'project' scope for file-level decisions"
    example:
      scope: "project"
    severity: moderate

workflows:
  - name: "decide_after_implementation"
    trigger: "Code changes to a file without a corresponding decision"
    expected_sequence:
      - twining_why  # Check existing decisions first
      - twining_decide  # Record the new decision
    scoring: sequence_present

  - name: "decide_with_alternatives"
    trigger: "Choosing between two or more approaches"
    expected_fields:
      alternatives: "non-empty array with at least 2 items"
```

## Transcript Analysis

Parse Claude Code JSONL transcripts directly instead of using `@constellos/claude-code-kit` (v0.4.0) because:
- The transcript format is simple JSONL with well-known structure
- The existing stop-hook already demonstrates the grep-based pattern for finding tool calls
- Adding a dependency for what amounts to ~100 lines of TypeScript parsing is over-engineering
- The format is: one JSON object per line, messages have `type` ("user"|"assistant"), content arrays with `tool_use`/`tool_result` blocks

Key transcript fields to extract:
- Tool call sequences (name, arguments, result)
- Tool call timestamps for ordering
- Subagent boundaries (isSidechain, agentId)
- Text content for LLM-as-judge analysis

## LLM-as-Judge Implementation

Use the **Anthropic SDK directly** (`@anthropic-ai/sdk`) rather than promptfoo, autoevals, or OpenEvals because:
- Judge prompts are simple: "Given this transcript excerpt, did the agent follow the behavioral spec? Score 0-1 with reasoning"
- The project already interfaces with Claude models (it IS a Claude Code plugin)
- No need for multi-provider comparison -- the judge model is fixed (Claude Sonnet)
- Adding a framework for 3-4 grading prompt templates is over-engineering

The SDK is NOT a new production dependency -- it's used in eval tests only (devDependency) or invoked via Claude Code headless mode (`claude -p --output-format json`).

**Judge approach:** Claude Code headless mode (`claude -p`) for LLM-as-judge calls. This avoids adding `@anthropic-ai/sdk` as a dependency entirely -- the eval harness shells out to `claude -p` with a grading prompt and parses the JSON output. This reuses the user's existing Claude authentication.

## Evaluation Harness Architecture

```
test/eval/                          # Eval test suites (vitest-evals)
  scenarios/                        # Scenario YAML files
    orient-at-start.yaml
    decide-after-changes.yaml
    handoff-on-incomplete.yaml
  scorers/                          # Custom scorer functions
    tool-sequence.scorer.ts
    decision-quality.scorer.ts
    scope-correctness.scorer.ts
  judges/                           # LLM-as-judge wrappers
    behavioral-judge.ts
  transcripts/                      # Real transcript fixtures
    good-session.jsonl
    bad-session.jsonl
  harness.eval.ts                   # Main eval test file

src/eval/                           # Eval infrastructure (compiled)
  spec-loader.ts                    # YAML spec loader with Zod validation
  transcript-parser.ts              # JSONL transcript parser
  types.ts                          # Shared eval types
```

**Integration with existing vitest:**
- Eval tests live in `test/eval/` alongside existing `test/` suites
- Run with `vitest run test/eval/` or a dedicated npm script `npm run eval`
- vitest-evals provides `describeEval()` and scorer primitives
- Existing `createTestServer()` helper reused for synthetic scenario playback

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Eval runner | `vitest-evals` | `promptfoo` | 21MB, 348 deps, requires Node >= 20 (project supports >= 18). vitest-evals is ~50KB, extends existing vitest |
| Eval runner | `vitest-evals` | `viteval` | Newer/less proven; vitest-evals is from Sentry, battle-tested |
| Eval runner | `vitest-evals` | Custom vitest wrappers | vitest-evals provides ToolCallScorer, scorer protocol, and eval-specific reporting for free |
| LLM judge | Claude Code headless | `autoevals` | AutoEvals requires OpenAI API key by default; routes through Braintrust proxy. Claude Code headless reuses existing auth, zero new deps |
| LLM judge | Claude Code headless | `@anthropic-ai/sdk` direct | Adds a devDependency; headless mode avoids even that |
| LLM judge | Claude Code headless | `promptfoo llm-rubric` | Part of the 21MB promptfoo bundle; overkill for a few grading prompts |
| Transcript parsing | Custom module | `@constellos/claude-code-kit` | v0.4.0, small community; simple JSONL parsing doesn't justify a dep |
| Spec format | YAML + Zod | JSON Schema | YAML is more readable for human-authored specs; Zod gives TS types for free |
| Spec format | YAML + Zod | Custom DSL | Unnecessary complexity; YAML covers the needs |
| Scenario runner | Existing test helpers | Playwright | Playwright is for browser testing; MCP tool calls are API-level, already handled by `callTool()` |

## What NOT to Add

These were considered and explicitly rejected:

| Technology | Why Rejected |
|------------|-------------|
| `promptfoo` | 21MB + 348 deps is absurd for a project with 8 total deps. Node >= 20 conflicts with project's >= 18 target. Its strength is multi-provider comparison, which is irrelevant here. |
| `@anthropic-ai/sdk` | Even as devDependency, it's unnecessary -- Claude Code headless mode provides the same LLM access with zero deps |
| `@constellos/claude-code-kit` | Pre-1.0, small community. The transcript format is simple JSONL; 100 lines of custom code is more maintainable than an external dep |
| `@langchain/core` / `openevals` | LangChain ecosystem is Python-first; TypeScript packages are heavy and pull in LangChain's dependency tree |
| `braintrust` + `autoevals` | Braintrust is a platform play; autoevals defaults to OpenAI/proxy. Not aligned with a Claude-native project |
| `deepeval` | Python-only |
| Redis / message queues | Evaluation is batch, not streaming. Vitest handles concurrency fine |

## Installation

```bash
# Single new devDependency
npm install -D vitest-evals

# Verify compatibility
npm test
```

**Total new dependency footprint:** ~50KB (vitest-evals only; it peer-depends on vitest which is already installed).

## Version Compatibility Matrix

| Package | Required | Current in Project | Compatible? |
|---------|----------|--------------------|-------------|
| vitest-evals | peer: vitest | vitest ^4.0.18 | VERIFY -- vitest-evals 0.5 may need vitest >=1.x, likely compatible but test before committing |
| js-yaml | ^4.x | ^4.1.0 | Yes -- already installed |
| zod | ^3.x | ^3.25.0 | Yes -- already installed |
| Node.js | >= 18 | >= 18 | Yes -- no change |

**Confidence note (MEDIUM):** vitest-evals 0.5.0 was published ~7 months ago. Vitest 4.0 is recent. There may be a minor compatibility gap. If vitest-evals doesn't work with vitest 4, the fallback is trivial: write a thin `describeEval()` wrapper (~30 lines) that uses plain vitest `describe`/`it` with custom scoring reporters. The ToolCallScorer pattern is simple enough to replicate.

## Sources

- [vitest-evals npm](https://www.npmjs.com/package/vitest-evals) -- Sentry's vitest extension for LLM evals
- [vitest-evals GitHub](https://github.com/getsentry/vitest-evals) -- ToolCallScorer, TaskResult, custom scorer API
- [Sentry blog: Evals are just tests](https://blog.sentry.io/evals-are-just-tests-so-why-arent-engineers-writing-them/) -- Philosophy and architecture
- [promptfoo npm](https://www.npmjs.com/package/promptfoo) -- 21.2MB, 348 deps (reason for rejection)
- [promptfoo vitest integration](https://www.promptfoo.dev/docs/integrations/jest/) -- Evaluated but rejected due to package weight
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) -- Eval-driven development, code-based vs model-based graders
- [Claude Code headless mode](https://code.claude.com/docs/en/headless) -- Programmatic LLM access via `claude -p`
- [Claude Code transcript tools](https://github.com/simonw/claude-code-transcripts) -- JSONL format documentation
- [@constellos/claude-code-kit](https://www.npmjs.com/package/@constellos/claude-code-kit) -- Evaluated but rejected; too early, simple JSONL doesn't justify dep
- [autoevals npm](https://www.npmjs.com/package/autoevals) -- Braintrust's scorer library (evaluated, rejected for OpenAI default)
