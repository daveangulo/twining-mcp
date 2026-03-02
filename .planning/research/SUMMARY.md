# Project Research Summary

**Project:** Twining MCP — v1.4 Agent Behavior Quality
**Domain:** Behavioral evaluation, LLM-as-judge, plugin tuning for MCP tool system
**Researched:** 2026-03-02
**Confidence:** HIGH

## Executive Summary

The v1.4 milestone adds a behavioral evaluation layer to an already-complete MCP server (32 tools, 614 tests, 8 plugin skills). The core challenge is not building more tools — it is measuring whether Claude Code agents actually use those tools correctly in real sessions. Experts in this domain build evaluation in three ordered layers: first a behavioral specification (what "correct" looks like), then an automated harness that grades transcripts against that spec, then an iterative tuning loop that improves plugin artifacts based on failures. This is eval-driven development applied to agent behavior quality, and Anthropic's own guidance is the primary authoritative source.

The recommended approach is almost entirely custom TypeScript on top of existing infrastructure, with one new devDependency (`vitest-evals`) as an optional consideration. The behavioral spec lives in `plugin/BEHAVIORS.md` as machine-parseable structured markdown with MUST/SHOULD/MUST NOT vocabulary. The eval harness uses plain vitest (already installed) with a separate config file for eval test suites. Synthetic scenarios define expected tool call sequences as YAML; deterministic scorers check structural patterns; LLM-as-judge (via Claude Code headless mode, adding zero new dependencies) handles qualitative assessment. The plugin tuning loop modifies skill/hook/agent files, not the MCP server core, preserving the orthogonal boundary between "tools work correctly" (614 existing tests) and "tools are used correctly" (new eval harness).

The key risks are Goodhart's Law (overfitting plugin prompts to pass evals rather than genuinely improving behavior), LLM judge flakiness in CI, and over-specification of behavioral rules that turns agents into Twining bureaucrats. All three are well-documented failure modes with clear mitigations: hold-out eval sets for Goodhart, deterministic-only CI with LLM judge behind an env-var gate for flakiness, and a hard cap of 8-12 MUST rules across all 32 tools for over-specification.

---

## Key Findings

### Recommended Stack

The stack recommendation is strongly minimal. The project already has vitest, zod, js-yaml, and the MCP SDK — everything needed for the eval harness. The only addition under consideration is `vitest-evals` (~50KB, from Sentry), which provides a `describeEval()` wrapper and scorer protocol. ARCHITECTURE.md notes that for 30-50 scenarios, plain vitest `describe`/`it`/`expect` is simpler and avoids a dependency with uncertain vitest 4.x compatibility. Practical recommendation: attempt vitest-evals first; fall back to a ~30-line custom wrapper if compatibility fails. LLM-as-judge calls go through Claude Code headless mode (`claude -p --output-format json`), adding zero new dependencies.

**Core technologies:**
- `vitest` (existing): Eval test runner via separate `vitest.config.eval.ts` — already the project test runner, no new runner needed
- `vitest-evals ^0.5.0` (optional new devDep): `describeEval()` and scorer protocol — verify vitest 4.x compatibility immediately; trivial 30-line fallback ready
- `zod` (existing): Behavioral spec schema validation — already used for all tool input schemas
- `js-yaml` (existing): Scenario YAML file parsing — already a project dependency
- Claude Code headless `claude -p`: LLM-as-judge execution — zero new dependencies, reuses existing user auth
- `@anthropic-ai/sdk` (potential devDep): Alternative LLM judge client — more reliable than headless; decide at Phase 4 based on headless reliability

**Explicitly rejected:** promptfoo (21MB, 348 deps, Node >= 20 conflict with project's >= 18 target), @constellos/claude-code-kit (pre-1.0, JSONL parsing doesn't justify the dep), autoevals (defaults to OpenAI/proxy), LangChain TypeScript (heavy, Python-first ecosystem).

### Expected Features

**Must have (table stakes):**
- Behavioral spec for all 32 tools — cannot evaluate without defining correct behavior
- Synthetic scenario runner (5-8 scenarios covering orient, decide, verify, coordinate, handoff) — reproducible behavioral tests
- Transcript parser (JSONL extraction of `twining_*` tool calls and file edits) — real-world validation
- Deterministic scorers (tool sequence, argument quality, ordering checks) — fast, free, reproducible baseline evaluation
- LLM-as-judge for qualitative aspects (rationale quality, scope appropriateness) — deterministic cannot check semantic quality
- Scoring and reporting integrated with vitest output — actionable pass/fail with per-scenario breakdown
- Plugin artifact testing (skill trigger validation, hook behavior, agent tool patterns)

**Should have (differentiators):**
- Workflow scenario specs (multi-tool orient-decide-verify, not just individual tool checks)
- Anti-pattern detection (actively scan for known bad patterns, not just absence of correct ones)
- Multiple trials per scenario — k=3 minimum; LLM non-determinism makes single-trial results meaningless
- Real transcript analysis from actual dogfooding sessions alongside synthetic scenarios
- Regression baseline — snapshot eval scores to detect plugin change regressions
- Grading rubric decomposition — one judge call per criterion, never monolithic prompts

**Defer (post-v1.4):**
- Comparative eval runs (automate plugin version comparison — do manually first)
- Coverage matrix (manual scenario file review sufficient initially)
- Remaining 22 tool specs beyond core 10 — validate pattern on core tools first, then expand
- Visual eval dashboard — vitest terminal output is sufficient

**MVP priority order:** Behavioral specs for 10 core tools → synthetic scenario runner (5-8 scenarios) → transcript parser → deterministic tool sequence scorer → LLM judge for qualitative grading → anti-pattern detection.

### Architecture Approach

The eval system is a development-time/CI-time layer with zero imports from `src/tools/`, `src/engine/`, or `src/storage/`. It does not require a running MCP server. Existing 614 tests cover server correctness; eval harness covers agent behavior quality. These are orthogonal and share no code.

The central decision is a single `plugin/BEHAVIORS.md` as the behavioral specification rather than 32+ per-tool YAML files. It lives alongside the skills it specifies, ships with the plugin, and is trivially parseable via markdown conventions. Synthetic scenarios do NOT call the real MCP server — they are declarative tool call sequence definitions. Scorers evaluate sequence structure, not tool output.

**Major components:**
1. `plugin/BEHAVIORS.md` — Behavioral specification: MUST/SHOULD/MUST NOT rules for all 32 tools, 8 workflows, and key anti-patterns. Single source of truth that ships with the plugin.
2. `test/eval/scenario-engine.ts` + `test/eval/scenarios/` — Synthetic scenario runner: loads YAML files defining tool call sequences, feeds scorer pipeline, never calls real MCP server.
3. `test/eval/transcript-analyzer.ts` — Real transcript parser: reads Claude Code session JSONL, extracts `twining_*` calls and file edits, builds interaction timeline for the same scorers.
4. `test/eval/scorers/` — Scorer pipeline: 7 deterministic scorers for structural checks (fast, free, 100% reproducible); 2 LLM-as-judge scorers for qualitative checks only.
5. `test/eval/judge.ts` — LLM-as-judge client: thin wrapper around Claude headless or SDK; one call per criterion (never monolithic).
6. `vitest.config.eval.ts` — Separate vitest config keeping eval suite independent; `npm run eval`, `npm run eval:synthetic`, `npm run eval:transcript`.

### Critical Pitfalls

1. **Goodhart's Law — overfitting plugin prompts to pass evals** — Maintain a holdout eval set separate from the tuning set. Validate every tuning cycle against real dogfooding transcripts. Track plugin token budget; growth >20% signals the wrong approach. Run the "5 realistic open-ended tasks" gut check.

2. **"Tool was called" vs. "tool was used correctly"** — Implement three-level evaluation from the start: (1) was it called, (2) were parameters reasonable (scope not "project", required fields present), (3) was output used appropriately in subsequent actions. Level 3 requires LLM judge.

3. **LLM judge non-determinism causing flaky evals** — Deterministic scorers only in CI. LLM judge behind `TWINING_EVAL_JUDGE=1` env-var gate, local-only. Multi-run consensus (3 runs, 2/3 agreement). Never block CI on LLM judge results.

4. **Over-specifying behavioral rules (brittle spec)** — Hard cap: 8-12 MUST rules across all 32 tools. If Twining calls exceed 30% of total tool calls in eval sessions, spec creates too much overhead. Measure the Twining-to-productive call ratio.

5. **Spec contradicting existing skill text** — 8 existing SKILL.md files already contain behavioral instructions. Write BEHAVIORS.md alongside existing skill content, not as a parallel layer. Tuning updates both together.

---

## Implications for Roadmap

The build order is fixed by dependencies: behavioral spec precedes harness, harness precedes plugin tuning. Within the harness, deterministic infrastructure precedes LLM judge.

### Phase 1: Behavioral Specification

**Rationale:** Everything depends on having machine-readable rules to score against. The spec is also the most valuable standalone artifact — even without the harness, it codifies what "good Twining usage" means and can ship in the plugin for transparency.
**Delivers:** `plugin/BEHAVIORS.md` (MUST/SHOULD/MUST NOT rules for all 32 tools and 8 workflows), `test/eval/types.ts` (shared TypeScript interfaces), `test/eval/behaviors-parser.ts` with tests.
**Addresses:** Table stakes (behavioral spec), deterministic grader criteria, plugin artifact testing criteria.
**Avoids:** Under-specification (Pitfall 5) by requiring concrete, grep-checkable rules with examples; spec-skill contradiction (Pitfall 12) by writing spec alongside existing SKILL.md files simultaneously; over-specification (Pitfall 4) by enforcing 8-12 MUST rule cap.

### Phase 2: Eval Harness — Deterministic Core

**Rationale:** Deterministic scorers (fast, free, reproducible) must be built and validated before adding LLM judge complexity. This phase delivers a working eval system that runs in CI on every push.
**Delivers:** `vitest.config.eval.ts`, scorer interface and registry, 7 deterministic scorers (assemble-before-decide, verify-before-complete, narrow-scope, decision-quality, warning-acknowledgment, stop-hook-compliance, coordination-protocol), scenario engine, 20-30 YAML synthetic scenarios across all 8 skill categories, npm scripts (`eval`, `eval:synthetic`, `eval:watch`).
**Uses:** Existing vitest, zod, js-yaml; vitest-evals if vitest 4.x compatible (smoke-test immediately with 30-line fallback ready).
**Implements:** Scenario Engine and Scorer Pipeline architecture components.
**Avoids:** Tool-call-only checking (Pitfall 2) by implementing three-level evaluation from the start; synthetic-only false confidence (Pitfall 6) by including real transcript fixtures even in this phase.

### Phase 3: Transcript Analysis

**Rationale:** Real transcript evaluation validates that synthetic scenarios match actual behavior patterns and surfaces spec gaps. Applied using the same scorers as Phase 2, so same grading logic covers both modes.
**Delivers:** `test/eval/transcript-analyzer.ts` with defensive JSONL parsing, `test/eval/transcript.eval.ts`, real transcript fixtures from existing dogfooding sessions, transcript npm script.
**Uses:** Existing JSONL format understanding from stop-hook patterns; defensive parsing against format instability.
**Avoids:** Transcript format instability (Pitfall 9) by building defensive parser with type guards and tests against multiple real Claude Code transcripts.

### Phase 4: LLM-as-Judge Integration

**Rationale:** Added after deterministic infrastructure is validated. Covers qualitative checks that cannot be checked structurally — rationale quality, scope appropriateness, relevance of findings. Kept strictly optional and local-only to avoid CI flakiness.
**Delivers:** `test/eval/judge.ts` (Claude headless wrapper or SDK client), 2 LLM-based scorers (rationale-quality, scope-appropriateness), `TWINING_EVAL_JUDGE=1` env-var gate, per-criterion judge calls.
**Uses:** Claude Code headless (`claude -p`) or `@anthropic-ai/sdk` devDep — resolve by testing headless mode reliability first.
**Avoids:** Flaky CI (Pitfall 3) by keeping judge local-only behind env-var gate; cost explosion (Pitfall 11) by limiting to 2 LLM scorers with focused transcript excerpts (500-1000 tokens, not full session).

### Phase 5: Plugin Tuning Cycle

**Rationale:** With the eval harness operational and baseline scores established, run the tuning loop: identify failures, modify plugin artifacts, re-run, measure improvement. This is the milestone's actual deliverable — the improved plugin, not the harness itself.
**Delivers:** Tuned `plugin/skills/*.md`, refined `plugin/hooks/` behavior, improved `plugin/agents/*.md`, passing eval suite, eval results report, regression baseline JSON for future CI comparison.
**Addresses:** All differentiator features (anti-pattern detection, regression baseline, real transcript validation).
**Avoids:** Goodhart's Law (Pitfall 1) by validating against holdout transcript fixtures after each tuning pass; testing the model not the plugin (Pitfall 13) by ensuring all criteria trace to specific skill instructions.

### Phase Ordering Rationale

- Phase 1 before all: the behavioral spec is a prerequisite for everything; scorers have no rules to score against without it.
- Phase 2 before Phase 3: verify scoring machinery works on controlled synthetic inputs before applying to noisy real transcripts.
- Phase 2 before Phase 4: validate deterministic infrastructure is solid before adding LLM judge complexity. Deterministic scorers catch ~80%+ of behavioral issues.
- Phase 4 before Phase 5: full scoring capability (deterministic + qualitative) needed for informed tuning decisions.
- Phase 5 is the output — the iterative tuning loop continues until the eval suite passes at target thresholds.
- No parallelism between phases: each phase depends on the previous. Within Phase 2, deterministic scorer development can proceed in parallel with scenario YAML authoring.

### Research Flags

Needs research/validation during planning:
- **Phase 1:** Review all 8 existing SKILL.md files before writing BEHAVIORS.md to ensure rule vocabulary captures existing guidance correctly and creates no contradictions.
- **Phase 2:** Smoke-test `npm install -D vitest-evals && npm test` immediately. Compatibility with vitest 4.0.x is uncertain; the 30-line custom fallback wrapper should be designed before starting.
- **Phase 4:** STACK.md and ARCHITECTURE.md disagree on judge approach (headless vs. SDK). Test Claude Code headless mode JSON output reliability (`claude -p --output-format json`) before committing. Low-stakes decision but needs resolution.

Standard patterns (skip deep research):
- **Phase 3:** JSONL transcript format is well-characterized by community tools. Build defensively and test against real transcripts; no deeper research needed.
- **Phase 5:** The tuning process is procedural — run eval, read failures, edit files, re-run. No architectural uncertainty.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Core stack (vitest + existing deps) is HIGH confidence. vitest-evals vitest 4.x compat is unverified — fallback trivial but needs immediate smoke-test. LLM judge approach (headless vs. SDK) has two valid options that disagree between research files; resolve at Phase 4. |
| Features | HIGH | Feature scope grounded in Anthropic's own eval guidance, Sentry's practical eval philosophy, and the existing plugin's 8 skill workflows. MVP ordering is clear and well-justified. |
| Architecture | HIGH | Grounded in Anthropic's "Demystifying evals for AI agents," community best practices, and direct analysis of existing codebase. Zero-touch-to-core-server boundary is architecturally sound and verified against existing code. |
| Pitfalls | HIGH | Sourced from Anthropic guidance, peer-reviewed papers (Agent Behavioral Contracts, MCP Tool Descriptions Are Smelly), and practical experience. Goodhart's Law and LLM judge flakiness are well-documented failure modes with clear mitigations. |

**Overall confidence:** HIGH

### Gaps to Address

- **vitest-evals vitest 4.x compatibility**: Cannot confirm without running `npm install -D vitest-evals && npm test`. Must verify in Phase 2 before building on it. Have 30-line fallback ready.
- **Claude Code headless JSON output reliability**: `claude -p --output-format json` needs smoke-testing for error handling and format stability before committing to it as the judge mechanism.
- **Transcript JSONL exact field structure**: Format documented by community tools but NOT officially by Anthropic. ARCHITECTURE.md notes MEDIUM confidence. Build parser defensively and test against real transcripts from this repo's sessions before finalizing.
- **Behavioral rule tier mapping for 32 tools**: Research recommends 8-12 total MUST rules but the project has 32 tools. Phase 1 must define tiers: Tier 1 (10 core tools with full MUST/SHOULD/MUST NOT spec), Tier 2 (remaining 22 with lighter coverage). This prioritization is not resolved by research alone.
- **Plugin token budget baseline**: Measure total token cost of all current plugin prompts (8 skills + 2 agents + hook messages) before Phase 5 tuning begins, to track growth and enforce the 20% cap.

---

## Sources

### Primary (HIGH confidence)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — eval architecture, grading strategies, "grade outcomes not paths," 20-50 scenario recommendation, code vs. LLM graders
- [Bloom: automated behavioral evaluations](https://alignment.anthropic.com/2025/bloom-auto-evals/) — 4-stage pipeline, seed-based scenario generation, Anthropic's own behavioral eval tooling
- Existing Twining codebase — 32 tools, 8 skills, 3 hooks, 2 agents, 614 tests, analytics engine, verify engine, stop-hook; all directly inspectable

### Secondary (MEDIUM confidence)
- [Sentry blog: Evals are just tests](https://blog.sentry.io/evals-are-just-tests-so-why-arent-engineers-writing-them/) — practical eval philosophy, vitest-evals architecture
- [vitest-evals GitHub (getsentry/vitest-evals)](https://github.com/getsentry/vitest-evals) — ToolCallScorer, TaskResult, scorer protocol API
- [LLM-as-a-Judge: Complete Guide - Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge) — rubric structure, bias mitigation
- [Amazon: Evaluating AI agents](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/) — multi-level testing, golden datasets from historical logs
- [simonw/claude-code-transcripts](https://github.com/simonw/claude-code-transcripts), [daaain/claude-code-log](https://github.com/daaain/claude-code-log) — JSONL transcript format reference and parsing patterns
- [Analyzing Claude Code Logs with DuckDB](https://liambx.com/blog/claude-code-log-analysis-with-duckdb) — transcript field structure

### Tertiary (MEDIUM-LOW confidence)
- [Agent Behavioral Contracts (arXiv 2602.22302)](https://arxiv.org/html/2602.22302) — hard/soft constraint separation framework
- [MCP Tool Descriptions Are Smelly (arXiv 2602.14878)](https://arxiv.org/html/2602.14878v1) — 89.8% unstated limitations, tool descriptions as spec+prompt
- [LLM Evaluation in 2025](https://medium.com/@QuarkAndCode/llm-evaluation-in-2025-metrics-rag-llm-as-judge-best-practices-ad2872cfa7cb) — LLM-as-judge patterns and bias mitigation
- [promptfoo npm](https://www.npmjs.com/package/promptfoo) — evaluated for rejection (21.2MB, 348 deps); confirms size and Node version concerns

---
*Research completed: 2026-03-02*
*Ready for roadmap: yes*
