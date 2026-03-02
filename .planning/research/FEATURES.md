# Feature Landscape: v1.4 Agent Behavior Quality

**Domain:** Behavioral specification, evaluation harness, plugin tuning
**Researched:** 2026-03-02

## Table Stakes

Features required for the eval system to be useful. Missing any of these means the harness cannot validate plugin quality.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Behavioral spec for all 32 tools | Cannot evaluate behavior without defining what "correct" looks like. Each tool needs: when to use, when not to use, anti-patterns, expected follow-ups | Med | YAML files validated by Zod. Existing skills already define some of this narratively -- extract and formalize |
| Scenario definitions (synthetic test cases) | Need reproducible situations where specific tool behavior is expected. Each scenario: setup state, user prompt, expected behavioral signals | Med | Scenarios need pre-seeded .twining/ state + task prompt. Cover orient-decide-verify lifecycle |
| Deterministic graders (transcript assertions) | Baseline evaluation -- check tool call names, argument patterns, sequencing, anti-pattern absence | Med | Parse transcripts. Existing stop-hook already does primitive transcript analysis |
| LLM-as-judge grading | Some behaviors (scope narrowing quality, rationale quality, proportionate recording) cannot be checked deterministically | Med | Single-criterion rubrics. Judge model evaluates transcript excerpt against rubric |
| Scoring and reporting | Raw judge/grader output must aggregate into actionable pass/fail with per-scenario detail | Low | Aggregate deterministic + LLM scores. Surface which rules failed and why |
| Eval runner integrated with vitest | Must be runnable as `npm run eval` using existing test infrastructure. No separate runner to maintain | Med | vitest-evals extends vitest. Eval tests in `test/eval/` alongside existing tests |
| Plugin artifact testing | Plugin (skills, hooks, agents) shapes agent behavior. Must test that skill triggers activate, hooks fire correctly, agent definitions produce correct tool patterns | Med | Test skill content against spec expectations, hook behavior against transcript patterns |

## Differentiators

Features that set a good eval system apart from basic testing.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Workflow scenario specs | Test multi-tool workflows (orient-decide-verify), not just individual tools. Multi-step patterns are where real failures happen | Med | YAML workflow definitions with expected tool sequences |
| Anti-pattern detection | Beyond checking for correct behavior, actively scan for known bad patterns (empty rationale, broad scope, wrong tool for action) | Low | Pattern matchers against transcript tool call arguments |
| Regression baseline | Snapshot eval scores so future plugin changes detect regressions. "Did this SKILL.md edit make agents worse?" | Low | Store baseline scores as JSON. Compare on each run |
| Multiple trials per scenario | LLM outputs are non-deterministic. Single trial is meaningless. Need pass@k (capability) and pass^k (reliability) | Low | Run each scenario k times (k=3 minimum). Report both metrics |
| Real transcript analysis | Beyond synthetic scenarios, analyze real session transcripts against behavioral spec | Med | Transcript ingestion from Claude Code session files. Same graders run on real data |
| Comparative eval runs | Run same scenarios with different plugin versions to measure improvement | Med | Parameterized vitest runs with different SKILL.md content |
| Grading rubric decomposition | Each criterion is a separate judge call, not one monolithic prompt. Follows G-Eval best practice | Low | Template per criterion. Each scores independently |
| Coverage matrix | Map which rules are tested by which scenarios. Identify blind spots | Low | Cross-reference rule IDs with scenario assertions |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Live agent execution in CI | Running Claude Code in CI is expensive, slow, and flaky from model variance | Synthetic scenario playback with pre-recorded tool sequences |
| Fine-tuning or model training | Twining shapes behavior through prompts (skills, hooks), not model weights | Tune plugin artifacts: skill wording, hook logic, agent tool lists |
| Autonomous eval-and-fix loop | Automatically rewriting skills based on eval failures is dangerous and unpredictable | Report failures for human review. Human decides how to modify plugin |
| Multi-model comparison | This is a Claude Code plugin; testing with GPT/Gemini is irrelevant | Fix judge model to Claude Sonnet via headless mode |
| Visual eval dashboard | Over-engineering; vitest terminal output is sufficient for v1.4 | Use vitest built-in reporter. Consider dashboard later if needed |
| Embedding-based semantic scoring | Using ONNX embeddings for answer similarity adds complexity without precision | Code-based and LLM-judge scorers are more interpretable |
| Probabilistic contract enforcement | ABC framework's runtime enforcement with drift bounds is research-grade | Offline evaluation with clear pass/fail assertions |
| Exhaustive scenario coverage | Testing every interaction path is combinatorial explosion | Focus on 8 primary workflows from existing skills plus known failure modes |

## Feature Dependencies

```
Behavioral Specs (YAML + Zod schemas)
  |
  +---> Synthetic Scenario Runner (needs specs to define expected behavior)
  |       |
  |       +---> Pass/Fail Scoring (needs scenario results)
  |       |       |
  |       |       +---> Regression Baseline (needs established scores)
  |       |
  |       +---> Multiple Trials (runner repeats scenarios k times)
  |
  +---> Transcript Analyzer (needs specs to grade real sessions)
  |       |
  |       +---> Anti-Pattern Detection (needs transcript parsing)
  |       |
  |       +---> LLM-as-Judge (needs transcript excerpts + specs as criteria)
  |
  +---> Plugin Tuning (needs eval results to know what to improve)
          |
          +---> Comparative Eval Runs (needs iterations to compare)

Existing Twining Infrastructure (already built, leveraged):
  - Stop Hook -> provides runtime behavioral checkpoint
  - callTool() test helper -> provides synthetic tool execution
  - All 32 MCP Tools -> behaviors being evaluated
  - 8 Skills -> behavioral guidance being evaluated
  - 2 Agents -> tool access patterns being evaluated
  - 3 Hooks -> runtime enforcement being evaluated
```

## MVP Recommendation

Prioritize in this order:

1. **Behavioral specs for 10 core tools** -- twining_assemble, twining_decide, twining_post, twining_why, twining_verify, twining_status, twining_handoff, twining_search_decisions, twining_recent, twining_read. These cover the primary workflows.

2. **Synthetic scenario runner** -- 5-8 scenarios covering main plugin skills: orient-at-start, decide-after-changes, verify-before-stop, handoff-on-incomplete, coordinate-delegation.

3. **Transcript parser** -- Extract tool call sequences from real JSONL transcripts.

4. **Tool sequence scorer** -- Grade whether tool call sequences match spec expectations.

5. **LLM-as-judge for qualitative grading** -- Rationale quality, scope appropriateness, when-to-use adherence.

6. **Anti-pattern detection** -- Catch known bad patterns from existing skill anti-pattern lists.

Defer:
- **Remaining 22 tool specs**: Fill in after core 10 are validated
- **Comparative eval runs**: Can be done manually by running evals twice. Automate after first tuning cycle
- **Regression baseline**: Needs initial eval scores established first
- **Multiple trials**: Start with k=1 for fast iteration, add k=3 once scoring is stable
- **Coverage matrix**: Manual review of scenario files is sufficient initially

## Workflow Scenario Categories

Based on the 8 existing skills, eval scenarios should cover:

| Workflow | Primary Skill | Key Rules | Scenario Count |
|----------|--------------|-----------|----------------|
| Session orientation | twining-orient | assemble before work, narrow scope, review warnings | 3-4 |
| Decision recording | twining-decide | use twining_decide not twining_post, include alternatives, rationale quality | 3-4 |
| Pre-completion verification | twining-verify | run before saying "done", address failures, link commits | 2-3 |
| Knowledge graph building | twining-map | add entities after structural changes, correct types, prune stale | 2-3 |
| Subagent dispatch | twining-dispatch | register before dispatch, handoff after return, acknowledge | 2-3 |
| Agent coordination | twining-coordinate | discover before delegate, capability matching | 1-2 |
| Session handoff | twining-handoff | structured results, context snapshot, status for incomplete | 1-2 |
| Pre-commit review | twining-review | trace chains, search related, link commits | 1-2 |
| Anti-pattern scenarios | (cross-cutting) | project scope overuse, blind decisions, ignored warnings, wrong tool | 3-4 |
| Stop hook enforcement | (hooks) | blocks on unrecorded changes, approves clean sessions | 2 |

**Total: ~22-30 scenarios**

## Grading Criteria (LLM-as-Judge Rubrics)

Each criterion scored independently:

| Criterion | What It Measures | Scale | Notes |
|-----------|-----------------|-------|-------|
| Context assembly quality | Did agent orient with appropriate scope before working? | 0-1 | Check scope narrowness, timing relative to decisions |
| Decision rationale quality | Are rationales clear, specific, and non-generic? | 0-1 | Judge reads decision content from transcript |
| Scope precision | Does agent use narrow scopes or default to "project"? | 0-1 | Specific paths get 1.0, "project" gets 0.2 |
| Warning responsiveness | Does agent read and act on warnings? | 0-1 | Check for warning acknowledgment |
| Tool selection appropriateness | Right Twining tool for each action? | 0-1 | twining_decide for decisions, not twining_post |
| Anti-pattern avoidance | Avoids known anti-patterns listed in skills? | 0-1 | Check absence of documented bad patterns |
| Verification thoroughness | Verify before claiming completion? | 0-1 | twining_verify called with relevant checks |
| Coordination protocol compliance | When dispatching, follows register-delegate-handoff-acknowledge? | 0-1 | Sequence completeness check |

## Sources

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) -- eval-driven development, code-based vs model-based graders
- [Sentry blog: Evals are just tests](https://blog.sentry.io/evals-are-just-tests-so-why-arent-engineers-writing-them/) -- Practical eval philosophy
- [vitest-evals ToolCallScorer](https://github.com/getsentry/vitest-evals) -- Built-in tool call evaluation
- [Bloom: automated behavioral evaluations](https://alignment.anthropic.com/2025/bloom-auto-evals/) -- 4-stage pipeline, seed-based scenario generation
- [MCP Tool Descriptions Are Smelly](https://arxiv.org/html/2602.14878v1) -- 89.8% unstated limitations, tool descriptions as spec+prompt
- Existing Twining plugin: 8 skills, 2 agents, 3 hooks, analytics engine, verify engine, stop-hook
