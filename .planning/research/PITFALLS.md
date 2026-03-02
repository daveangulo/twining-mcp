# Domain Pitfalls: v1.4 Agent Behavior Quality

**Domain:** Behavioral specification, evaluation harness, LLM-as-judge, plugin tuning for MCP tool system
**Researched:** 2026-03-02

## Critical Pitfalls

Mistakes that cause rewrites, invalidate evaluation results, or produce a system that makes agents worse.

### Pitfall 1: Goodhart's Law -- Overfitting Plugin Prompts to Pass Evals

**What goes wrong:** Plugin skills/hooks get tuned until evals pass, but the tuned prompts perform worse in real usage because they're optimized for the eval distribution, not actual usage. Prompt engineering shows diminishing returns past ~75% accuracy; further gains require architectural changes, not wordsmithing.

**Consequences:** Plugin prompts bloated with edge-case handling that wastes tokens. Agent becomes formulaic. "Whack-a-mole" failures where fixing one eval breaks another.

**Prevention:**
1. Maintain separate "tuning set" and "holdout set" of eval scenarios
2. Every tuning cycle must validate against real dogfooding transcripts
3. Track plugin text token budget -- if it grows >20% during tuning, approach is wrong
4. "Does the agent seem natural?" gut check with 5 realistic open-ended tasks

**Detection:** Eval scores improve but real-world task completion time increases. Plugin text has grown significantly. Agent makes unnecessary Twining calls.

### Pitfall 2: Confusing "Tool Was Called" with "Tool Was Used Correctly"

**What goes wrong:** Eval checks whether `twining_assemble` appears in transcript. It does. Eval passes. But agent called it with `scope: "project"` (too broad), ignored warnings, and contradicted active decisions. Tool was called; it was not used correctly.

**Consequences:** False confidence. Agents "cargo cult" tool calls. Spec becomes checklist of tool names, not description of correct workflows.

**Prevention:** Three-level tool evaluation:
- Level 1 (deterministic): Was the tool called?
- Level 2 (deterministic): Were parameters reasonable? (scope not "project" for single-file work, required fields populated)
- Level 3 (LLM judge): Was the tool's output used appropriately in subsequent actions?

**Detection:** High tool-call compliance but low workflow quality. Agents calling right tools with generic/default parameters.

### Pitfall 3: LLM-as-Judge Non-Determinism Causing Flaky Evals

**What goes wrong:** Scenario passes 7/10 times. Is agent flaky or judge flaky? Research shows LLM judge accuracy varies up to 15% across runs. Agent non-determinism + judge non-determinism = compounding uncertainty.

**Consequences:** Eval suites that "flap." Unable to detect real regressions. Developers lose trust.

**Prevention:**
1. Maximize deterministic evaluation (tool presence, parameter validation, ordering -- all deterministic)
2. Reserve LLM judge ONLY for semantic quality checks requiring language understanding
3. Multi-run consensus: 3 runs, require 2/3 agreement for LLM judge
4. Never run LLM judge in CI. Code-based graders only in CI
5. Track per-scenario pass rates; flag <90% consistency as "unstable"

**Detection:** CI shows different eval results without code changes. Developers can't reproduce failures locally.

### Pitfall 4: Over-Specifying Behavioral Rules (Brittle Spec)

**What goes wrong:** Spec prescribes exact tool call sequences for every situation. Agent spends 40%+ of turns on Twining housekeeping. Rules conflict with each other. Research confirms: impractical to enumerate all acceptable behaviors.

**Consequences:** Agent becomes a Twining bureaucrat. Rules conflict. Real users disable the plugin.

**Prevention:**
1. Categorize rules: Hard (must), Soft (should), Suggestion (may)
2. Hard cap: no more than 15-20 hard rules across all 32 tools. Aim for 8-12
3. Measure Twining-to-productive tool call ratio in evals. If Twining calls >30% of total, spec creates too much overhead
4. Explicitly define what agent should NOT do (often more valuable than prescribing what it should)

**Detection:** Spec exceeds 3000 words. Agents in evals spend more turns on Twining than actual task.

### Pitfall 5: Under-Specifying Behavioral Rules (Useless Spec)

**What goes wrong:** Spec says "agents should use Twining tools appropriately." What's "appropriate"? LLM judges interpret vague rules differently. No objective improvement measurement.

**Prevention:**
1. Concrete observable criteria: "Must call `twining_assemble` before `twining_decide` in same scope"
2. "Could a grep catch it?" test -- if yes, rule is concrete enough
3. Include good and bad examples for each workflow rule
4. Start with 10-12 highly concrete rules. Add softer rules only after concrete ones are stable

**Detection:** LLM judge inter-run agreement below 70% on same transcript. Eval results don't change when plugin text is modified.

## Moderate Pitfalls

### Pitfall 6: Synthetic-Only False Confidence

**What goes wrong:** Synthetic scenarios all pass, but real transcript analysis reveals completely different behavior. Eval gives false confidence.

**Prevention:**
1. Include real transcript analysis from day one
2. Collect 3-5 real Claude Code session transcripts as ground truth
3. Grade real transcripts with same scorers as synthetic scenarios
4. Discrepancies between synthetic and real scores reveal spec gaps

**Detection:** All synthetic scenarios pass but users report poor Twining adoption.

### Pitfall 7: vitest-evals Compatibility with vitest 4

**What goes wrong:** vitest-evals 0.5.0 published ~7 months ago. vitest 4.0 is recent. API changes may break integration.

**Prevention:** Test immediately. Fallback is trivial: ~30-line `describeEval()` wrapper using plain vitest `describe`/`it`. The ToolCallScorer pattern is a simple function returning `{score, reason}`.

**Detection:** Import errors or type mismatches after `npm install -D vitest-evals`.

### Pitfall 8: Claude Code Headless Mode Unavailability

**What goes wrong:** LLM judge depends on `claude -p` being available. Missing in CI, Docker, or machines without Claude Code.

**Prevention:**
1. Judge is always optional -- eval tests must pass without judge calls
2. Judge tests behind environment variable gate (`TWINING_EVAL_JUDGE=1`)
3. Code-based graders are primary mechanism; judge is supplementary

**Detection:** `which claude` check in judge module. Skip gracefully if unavailable.

### Pitfall 9: Transcript Format Instability

**What goes wrong:** Claude Code updates JSONL transcript format. Custom parser breaks.

**Prevention:**
1. Parser is defensive: unknown fields ignored, missing fields have defaults
2. Extract only needed fields: tool name, arguments, result, message role
3. Test parser against real transcripts from different Claude Code versions
4. Parse by tool name matching (stable identifier), not by position or structure

**Detection:** Parser test failures after Claude Code updates.

### Pitfall 10: Eval Maintenance Burden

**What goes wrong:** 30+ scenario files, 10+ scorers, 8 judge rubrics, 22 spec files. Every plugin change requires updating multiple eval artifacts.

**Prevention:**
1. Specs are independent per-tool -- changing one doesn't affect others
2. Scenarios reference specs by tool name, not by copying content
3. Scorers are generic (tool sequence, argument quality) not per-scenario
4. Start with 10 specs and 8 scenarios. Expand only on proven gaps

**Detection:** Updating a single SKILL.md requires changes to more than 2 eval files.

### Pitfall 11: LLM Judge Cost Explosion

**What goes wrong:** (scenarios) x (criteria) x (consensus runs) x (tokens per judgment) = expensive. Single eval run costs $50-200.

**Prevention:**
1. Deterministic-first: majority of checks cost zero tokens
2. Judge prompt compression: extract relevant section, not full transcript (10k tokens -> 500-1000)
3. Tiered CI: deterministic on commit, LLM judge on PR (critical rules only), full suite weekly
4. Cache identical transcript evaluations

**Detection:** Monthly eval costs exceed MCP server infrastructure costs.

### Pitfall 12: Specs Contradicting Existing Skill Text

**What goes wrong:** 8 existing skills already contain behavioral instructions. If behavioral spec defines conflicting rules, agents receive contradictory instructions.

**Prevention:** Spec must be written WITH awareness of existing skill content. Tuning updates skill text to be consistent with spec -- not a parallel instruction layer.

## Minor Pitfalls

### Pitfall 13: Testing the Model, Not the Plugin

**What goes wrong:** Eval scenarios test whether Claude is "smart enough" rather than whether plugin guidance produces correct behavior.

**Prevention:** All criteria must trace to a specific skill instruction or hook behavior. "Did agent call twining_assemble before twining_decide?" (plugin behavior) not "Did agent write good code?" (model capability).

### Pitfall 14: Monolithic Judge Prompts

**What goes wrong:** Entire transcript sent to one giant judge prompt with 8 criteria. LLMs lose focus, scores unreliable.

**Prevention:** One judge call per criterion. Each gets focused rubric. Aggregate after independent evaluation.

### Pitfall 15: Missing "Unnecessary Tool Call" Anti-Pattern

**What goes wrong:** Eval only checks for missing tool calls, never for unnecessary ones. Agent that calls `twining_assemble` 5 times in a short session passes all checks.

**Prevention:** Include "should NOT call" assertions. "Agent should not call twining_assemble more than once for same scope within 10 turns." Negative assertions are as important as positive ones.

### Pitfall 16: One-Size-Fits-All Behavioral Rules

**What goes wrong:** Same rules for main session agents, subagents, and coordinators. But they have different roles, context budgets, and tool access.

**Prevention:** Define behavioral profiles per agent type:
- Main session: Full orient-decide-verify lifecycle
- Subagent (twining-aware-worker): Lightweight -- assemble on start, post status on finish
- Coordinator: Query-focused -- assemble/query primary, decisions rare

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Behavioral Spec | Over-specification (P4) | 8-12 hard rules for Tier 1 tools only. Token-budget spec at 3500 tokens |
| Behavioral Spec | Under-specification (P5) | Good/bad examples per rule. Test with LLM judge on 5 sample transcripts |
| Behavioral Spec | Spec contradicts skills (P12) | Write spec alongside skill text. Update both together |
| Eval Infrastructure | vitest-evals compat (P7) | Smoke-test immediately. 30-line fallback ready |
| Eval Infrastructure | Transcript coupling (P9) | Parser abstraction first. Test with multiple real transcripts |
| Eval Infrastructure | Tool-call-only checking (P2) | Three-level evaluation from the start |
| Scenario Authoring | Synthetic-only (P6) | Include 3-5 real transcript fixtures alongside synthetic |
| LLM Judge | Flakiness in CI (P3) | Judge is local-only, opt-in, behind env var gate |
| LLM Judge | Cost explosion (P11) | Deterministic-first. Judge prompt compression. Tiered CI |
| Plugin Tuning | Goodhart's law (P1) | Holdout eval set. Real transcript validation. Token budget tracking |
| Plugin Tuning | Testing model not plugin (P13) | All criteria trace to specific skill instruction |

## Sources

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) -- eval architecture, grading strategies
- [Sentry blog: Evals are just tests](https://blog.sentry.io/evals-are-just-tests-so-why-arent-engineers-writing-them/) -- keeping evals simple
- [Bloom: automated behavioral evaluations](https://alignment.anthropic.com/2025/bloom-auto-evals/) -- scenario diversity
- [Agent Behavioral Contracts](https://arxiv.org/html/2602.22302) -- hard/soft constraint separation
- [AGENTS.md Patterns](https://blakecrosley.com/blog/agents-md-patterns) -- anti-patterns in agent instructions
- [MCP Tool Descriptions Are Smelly](https://arxiv.org/html/2602.14878v1) -- unstated limitations
- Existing Twining stop-hook: `plugin/hooks/stop-hook.sh` -- transcript analysis prior art
