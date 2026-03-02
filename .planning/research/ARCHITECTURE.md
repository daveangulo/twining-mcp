# Architecture Patterns: Behavioral Evaluation & Plugin Tuning

**Domain:** Agent behavioral evaluation, LLM-as-judge, transcript analysis, plugin tuning
**Researched:** 2026-03-02
**Confidence:** HIGH (integration points verified against existing codebase; evaluation patterns grounded in Anthropic's own guidance and ecosystem tooling)

---

## Recommended Architecture

### System Overview

The behavioral eval system adds three new component groups to Twining without modifying the core MCP server runtime. It is a **development-time** and **CI-time** layer, not a runtime layer. The eval infrastructure reads from existing data (transcripts, plugin files, tool definitions) and produces evaluation reports. The only runtime artifact is the tuned plugin itself.

```
                                  EXISTING (unchanged)
                    +------------------------------------------+
                    |           Twining MCP Server              |
                    |  src/tools/ -> src/engine/ -> src/storage |
                    +------------------------------------------+
                    |         Plugin (skills/hooks/agents)       |
                    |  plugin/skills/ hooks/ agents/ commands/   |
                    +------------------------------------------+

                                  NEW (v1.4)
+-----------------------------------------------------------------------+
|                                                                       |
|  1. BEHAVIORAL SPEC                                                   |
|     plugin/BEHAVIORS.md          <-- single source of truth           |
|     (human-authored, machine-readable behavioral rules)               |
|                                                                       |
|  2. EVAL HARNESS (test/eval/)                                         |
|     +------------------+    +--------------------+                    |
|     | Scenario Engine  |    | Transcript Analyzer |                   |
|     | (synthetic)      |    | (real sessions)     |                   |
|     +--------+---------+    +---------+----------+                    |
|              |                        |                               |
|              v                        v                               |
|     +-------------------------------------------+                     |
|     |          Scorer Pipeline                   |                    |
|     |  (deterministic + LLM-as-judge scorers)    |                    |
|     +-------------------+-----------------------+                     |
|                         |                                             |
|                         v                                             |
|     +-------------------------------------------+                     |
|     |          Eval Report                       |                    |
|     |  (.planning/eval-results/ or stdout)       |                    |
|     +-------------------------------------------+                     |
|                                                                       |
|  3. PLUGIN TUNING (iterative)                                         |
|     Modify plugin/ files -> run eval -> measure -> repeat             |
|                                                                       |
+-----------------------------------------------------------------------+
```

### Component Boundaries

| Component | Responsibility | Communicates With | New/Modified |
|-----------|---------------|-------------------|-------------|
| `plugin/BEHAVIORS.md` | Defines expected agent behaviors as machine-readable rules | Read by Scenario Engine, Transcript Analyzer, LLM-as-judge prompts | **NEW file** |
| `test/eval/scenarios/` | Synthetic scenario definitions (YAML) | Feeds Scenario Engine | **NEW directory** |
| `test/eval/scenario-engine.ts` | Runs synthetic scenarios against scorer pipeline | Reads scenarios, calls scorers | **NEW module** |
| `test/eval/transcript-analyzer.ts` | Parses real Claude Code session JSONL transcripts | Reads `~/.claude/projects/` transcripts, calls scorers | **NEW module** |
| `test/eval/scorers/` | Deterministic + LLM-based scoring functions | Called by both engines, reads BEHAVIORS.md | **NEW directory** |
| `test/eval/judge.ts` | LLM-as-judge wrapper (Claude API calls) | Called by LLM-based scorers | **NEW module** |
| `test/eval/types.ts` | Shared types for eval infrastructure | Imported by all eval modules | **NEW module** |
| `test/eval/*.eval.ts` | Vitest test files that run evals | Orchestrate scenario engine + transcript analyzer | **NEW test files** |
| `plugin/skills/` | Plugin skill definitions (SKILL.md files) | Target of tuning; read by eval for comparison | **MODIFIED (tuned)** |
| `plugin/hooks/` | Hook scripts | Target of tuning | **MODIFIED (tuned)** |
| `plugin/agents/` | Agent definitions | Target of tuning | **MODIFIED (tuned)** |

---

## Layer 1: Behavioral Specification (`plugin/BEHAVIORS.md`)

### Location Decision

**`plugin/BEHAVIORS.md`** -- lives alongside the skills/hooks/agents it specifies because:
1. It ships with the plugin (users can read what good behavior means)
2. Plugin version bumps include behavioral spec changes
3. Skills reference it; eval harness reads it
4. It is the contract between "what we tell the agent" and "what we test"

### Why a Single Markdown File (Not Per-Tool YAML)

A single BEHAVIORS.md is preferable to 32+ individual YAML spec files because:
- **Human-readable**: Developers and users can read behavioral expectations in one place
- **Cross-tool rules**: Workflows span multiple tools (orient-work-verify) -- a single file captures these naturally
- **Simpler maintenance**: One file to update, not 32+ files to keep consistent
- **Machine-parseable**: Structured markdown with H2/H3/bullet conventions is trivially parseable
- **Ships with plugin**: Users install the plugin and see BEHAVIORS.md alongside SKILL.md files

### Structure

The spec uses a structured markdown format with explicit MUST/SHOULD/MUST NOT rules:

```markdown
# Twining Behavioral Specification

## Tool: twining_assemble
### MUST
- Call before any code modification or architectural decision
- Use narrowest scope that covers the work area
- Review returned warnings before proceeding

### SHOULD
- Call when switching to a different area of the codebase
- Include specific task description (not generic "working on code")

### MUST NOT
- Skip assembly before calling twining_decide
- Use scope "project" when a narrower scope applies

## Workflow: Orient-Work-Verify
### MUST
- Begin every task with orient phase (twining_assemble + twining_why)
- End every task with verify phase (twining_verify)
- Record decisions for any non-trivial architectural choice

## Anti-Pattern: Decision Without Context
### Definition
Calling twining_decide without a preceding twining_assemble in the same session
### Severity: HIGH
### Detection: Check transcript for twining_decide calls not preceded by twining_assemble
```

### Parsing Strategy

Parse BEHAVIORS.md into a structured representation at eval startup:

```typescript
interface BehavioralRule {
  id: string;                // e.g., "tool:twining_assemble:MUST:call-before-modification"
  category: 'tool' | 'workflow' | 'anti-pattern';
  subject: string;           // tool name, workflow name, or anti-pattern name
  level: 'MUST' | 'SHOULD' | 'MUST_NOT';
  rule: string;              // the behavioral requirement text
  severity?: 'HIGH' | 'MEDIUM' | 'LOW';  // for anti-patterns
  detection?: string;        // how to detect programmatically
}
```

A simple markdown parser extracts headers and bullet points into this structure. No special DSL needed -- just conventions within markdown.

---

## Layer 2: Eval Harness (`test/eval/`)

### Why Vitest (Not a Separate Runner)

Use vitest because:
1. **Already the project's test runner** -- 614 tests across 48 suites use vitest
2. **Parallel execution** via `describe.concurrent` handles slow LLM-as-judge calls
3. **Retry support** via `test.retry(N)` handles non-deterministic LLM scoring
4. **Existing CI integration** -- `npm test` already runs vitest
5. **Threshold assertions** via standard `expect()` -- no custom matchers needed
6. **Separation via config** -- `vitest.config.eval.ts` keeps evals independent

### Why NOT External Eval Frameworks

Do NOT use promptfoo, vitest-evals, or viteval as dependencies:
- **promptfoo**: Heavy dependency tree, YAML-centric config, designed for prompt engineering not behavioral eval
- **vitest-evals**: Adds the `describeEval` abstraction and scorer protocol -- unnecessary overhead for 30-50 scenarios where plain `describe`/`it`/`expect` suffice
- **viteval**: Early-stage, small community, adds another abstraction layer

The eval surface is small enough (20-50 scenarios per Anthropic's guidance) that custom scorers in plain vitest are simpler and more maintainable. If the pattern proves valuable, extracting a framework later is straightforward.

### Vitest Configuration

Add a separate vitest config for evals that can run independently:

```typescript
// vitest.config.eval.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/eval/**/*.eval.ts'],
    testTimeout: 120000,  // LLM-as-judge calls are slow
    retry: 2,             // Non-deterministic LLM scoring may need retries
    pool: 'threads',
    poolOptions: {
      threads: { maxThreads: 4 }  // Limit parallel API calls
    },
  },
});
```

Add npm scripts:
```json
{
  "eval": "vitest run --config vitest.config.eval.ts",
  "eval:watch": "vitest --config vitest.config.eval.ts",
  "eval:synthetic": "vitest run --config vitest.config.eval.ts test/eval/synthetic.eval.ts",
  "eval:transcript": "vitest run --config vitest.config.eval.ts test/eval/transcript.eval.ts"
}
```

### Two Evaluation Modes

#### Mode A: Synthetic Scenario Evaluation

Tests behavioral rules against **simulated** tool call sequences. No real LLM calls for the "agent" -- only optionally for judge scoring.

```
Scenario YAML  -->  Scenario Engine  -->  Scorer Pipeline  -->  Pass/Fail
```

A scenario defines:
```typescript
interface EvalScenario {
  id: string;
  name: string;
  description: string;
  category: 'orient' | 'decide' | 'verify' | 'coordinate' | 'anti-pattern';

  // The simulated tool call sequence (what an agent "did")
  tool_calls: SimulatedToolCall[];

  // Context about the session state
  session_context?: {
    files_modified?: string[];
    scope?: string;
    decisions_in_scope?: number;
    warnings_in_scope?: number;
  };

  // Expected evaluation outcomes
  expected: {
    rules_satisfied: string[];   // rule IDs that should pass
    rules_violated: string[];    // rule IDs that should fail
    overall: 'good' | 'bad' | 'mixed';
  };
}

interface SimulatedToolCall {
  tool: string;          // e.g., "twining_assemble"
  input: Record<string, unknown>;
  timestamp_offset_ms: number;  // relative to scenario start
}
```

Scenarios are defined as YAML files in `test/eval/scenarios/`:
```yaml
# test/eval/scenarios/orient/proper-orient-decide.yaml
id: orient-before-decide
name: "Proper orient-decide sequence"
category: orient
description: "Agent assembles context before making a decision"

tool_calls:
  - tool: twining_assemble
    input: { task: "refactor auth module", scope: "src/auth/" }
    timestamp_offset_ms: 0
  - tool: twining_why
    input: { scope: "src/auth/middleware.ts" }
    timestamp_offset_ms: 500
  - tool: twining_decide
    input:
      domain: architecture
      scope: "src/auth/"
      summary: "Switch from sessions to JWT"
      context: "Need horizontal scaling"
      rationale: "JWT enables stateless auth"
      alternatives:
        - option: "Redis sessions"
          reason_rejected: "Adds infrastructure"
    timestamp_offset_ms: 60000

expected:
  rules_satisfied:
    - "tool:twining_assemble:MUST:call-before-modification"
    - "workflow:orient-work-verify:MUST:begin-with-orient"
  rules_violated: []
  overall: good
```

**Key design insight:** Synthetic scenarios do NOT call the real MCP server. They are declarative descriptions of tool call sequences. Scorers evaluate the sequence structure, not tool output. This is critical -- we are testing whether the **behavioral pattern** is correct, not whether the tools work (that is what the existing 614 tests do).

#### Mode B: Real Transcript Analysis

Parses actual Claude Code session JSONL files and evaluates the Twining tool usage patterns within them.

```
Session JSONL  -->  Transcript Analyzer  -->  Scorer Pipeline  -->  Report
```

```typescript
interface TranscriptEvalInput {
  transcript_path: string;   // path to .jsonl session file
  project_path?: string;     // to resolve relative paths
}

interface ParsedTranscript {
  session_id: string;
  messages: TranscriptMessage[];
  tool_calls: ExtractedToolCall[];  // all tool calls, filtered to twining_*
  file_edits: FileEdit[];           // Write/Edit tool calls
  duration_ms: number;
}

interface ExtractedToolCall {
  tool: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  timestamp: string;
  message_index: number;
}
```

The transcript analyzer:
1. Reads the JSONL file line by line
2. Extracts all `tool_use` blocks where `name` starts with `twining_`
3. Also extracts `Write`, `Edit`, `NotebookEdit` tool calls (to detect code changes)
4. Builds a timeline of Twining interactions
5. Feeds the extracted data to the scorer pipeline

**Transcript JSONL format** (MEDIUM confidence -- inferred from community tools, not official docs):

```typescript
// Each line is a JSON object. Key message types:
// User message
{ type: "user", message: { role: "user", content: [...] }, timestamp: string }

// Assistant message with tool use
{ type: "assistant", message: { role: "assistant", content: [
  { type: "text", text: "..." },
  { type: "tool_use", id: "...", name: "twining_assemble", input: {...} }
] }, timestamp: string }

// Tool result
{ type: "tool_result", tool_use_id: "...", content: [...] }
```

The parser MUST handle format variations gracefully -- skip unrecognized lines, use type guards, log warnings for unexpected shapes. The format is not formally documented by Anthropic and may evolve.

### Scorer Pipeline

Scorers come in two types:

#### Deterministic Scorers (fast, free, reliable)

These check structural patterns in tool call sequences. They are the primary evaluation method.

```typescript
interface Scorer {
  id: string;
  name: string;
  rules: string[];  // behavioral rule IDs this scorer checks
  score(
    calls: SimulatedToolCall[] | ExtractedToolCall[],
    context?: SessionContext
  ): ScorerResult | Promise<ScorerResult>;
}

interface ScorerResult {
  scorer_id: string;
  score: number;          // 0.0 to 1.0
  pass: boolean;          // score >= threshold
  threshold: number;
  details: RuleResult[];
}

interface RuleResult {
  rule_id: string;
  satisfied: boolean;
  evidence: string;       // human-readable explanation
}
```

Example deterministic scorers:

| Scorer | What It Checks | Rules Covered |
|--------|---------------|---------------|
| `AssembleBeforeDecideScorer` | Every `twining_decide` preceded by `twining_assemble` or `twining_why` | orient MUST rules |
| `VerifyBeforeCompleteScorer` | `twining_verify` called before session end | verify MUST rules |
| `NarrowScopeScorer` | Scope is not "project" when narrower scope is possible | scope MUST NOT rules |
| `DecisionQualityScorer` | `twining_decide` includes alternatives, rationale, affected_files | decide MUST rules |
| `WarningAcknowledgmentScorer` | Warnings in assembled context are acknowledged/resolved | orient MUST rules |
| `StopHookComplianceScorer` | Code edits followed by Twining recording before session end | verify MUST rules |
| `CoordinationProtocolScorer` | `twining_register` before `twining_handoff`; acknowledge after | coordinate MUST rules |

#### LLM-as-Judge Scorers (slow, costly, nuanced)

For aspects that cannot be checked structurally -- quality of rationale, appropriateness of scope choice, relevance of findings posted.

The judge module wraps Claude API calls via `@anthropic-ai/sdk`:

```typescript
// test/eval/judge.ts
import Anthropic from '@anthropic-ai/sdk';

export class JudgeClient {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();  // uses ANTHROPIC_API_KEY env var
  }

  async evaluate(prompt: string, rubric: string): Promise<JudgeResponse> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',  // Sonnet for judge: fast + cheap
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are evaluating an AI agent's behavior against a rubric.

## Rubric
${rubric}

## Agent Behavior
${prompt}

Score 0.0 to 1.0 based on the rubric. Respond with JSON only:
{"score": <number>, "reasoning": "<explanation>", "rule_results": [{"rule_id": "<id>", "satisfied": <bool>, "evidence": "<text>"}]}`
      }],
    });
    // parse response...
  }
}
```

**Judge model choice:** Use Claude Sonnet (not Opus) for judge calls. Sonnet is faster, cheaper ($3/$15 per million tokens), and sufficiently capable for rubric-based evaluation. The rubric provides the evaluation structure -- the judge just applies it.

**Cost control:** LLM-as-judge scorers are opt-in. They only run when `EVAL_LLM_JUDGE=true` is set. Deterministic scorers always run. CI runs cheap deterministic evals on every push; LLM-judge evals run on manual trigger or scheduled.

### Eval Report

```typescript
interface EvalReport {
  timestamp: string;
  mode: 'synthetic' | 'transcript' | 'both';
  scenarios_evaluated: number;
  overall_score: number;         // weighted average across all scorers
  pass: boolean;                 // overall_score >= global threshold

  by_category: Record<string, {
    score: number;
    pass: boolean;
    scenario_count: number;
  }>;

  by_scorer: Record<string, {
    score: number;
    pass: boolean;
    rule_results: RuleResult[];
  }>;

  failures: {
    scenario_id: string;
    scorer_id: string;
    rule_id: string;
    evidence: string;
  }[];
}
```

Reports are written to stdout (in vitest) and optionally to `.planning/eval-results/` as JSON for trend tracking.

---

## Layer 3: Plugin Tuning (Iterative Process)

### Tuning Loop

```
1. Run eval (npm run eval)
2. Identify failing rules
3. Modify plugin files:
   - Adjust SKILL.md instructions to be clearer
   - Add/modify hook behavior
   - Refine agent prompts
   - Update BEHAVIORS.md if a rule is wrong
4. Re-run eval
5. Repeat until passing
```

### What Gets Tuned

| Artifact | How It Gets Tuned |
|----------|------------------|
| `plugin/skills/*.md` | Clearer instructions, better "When to Invoke" triggers, sharper anti-patterns |
| `plugin/hooks/stop-hook.sh` | More precise detection of unrecorded changes |
| `plugin/hooks/subagent-stop-hook.sh` | Better subagent handoff prompts |
| `plugin/agents/*.md` | Improved tool lists, guidelines, capabilities |
| `src/instructions.ts` | Refined MCP instructions for non-plugin clients |
| `plugin/BEHAVIORS.md` | Rule refinement when eval reveals the spec is wrong |

### What Does NOT Get Modified

- `src/tools/` -- tool implementations are unchanged
- `src/engine/` -- engine logic is unchanged
- `src/storage/` -- storage layer is unchanged
- `test/*.test.ts` -- existing unit/integration tests are unchanged

This is a key architectural boundary: **eval tests the plugin's behavioral guidance, not the MCP server's functionality.**

---

## Data Flow

### Synthetic Evaluation Flow

```
plugin/BEHAVIORS.md
        |
        v
[Parse into BehavioralRule[]]
        |
        v
test/eval/scenarios/*.yaml  -->  [Load scenarios]
        |                              |
        v                              v
[Scenario Engine: iterate scenarios]
        |
        v
[For each scenario: run deterministic scorers]
        |
        +--[if EVAL_LLM_JUDGE=true]--> [Run LLM scorers via Claude API]
        |
        v
[Aggregate ScorerResult[] into EvalReport]
        |
        v
[Assert in vitest: expect(report.overall_score).toBeGreaterThan(0.8)]
```

### Transcript Evaluation Flow

```
~/.claude/projects/<path>/sessions/*.jsonl
  (or test/eval/transcripts/*.jsonl for fixtures)
        |
        v
[Transcript Analyzer: parse JSONL, extract twining_* calls + file edits]
        |
        v
[Filter to sessions that used Twining tools]
        |
        v
plugin/BEHAVIORS.md --> [Parse rules]
        |
        v
[For each transcript: run deterministic scorers]
        |
        +--[if EVAL_LLM_JUDGE=true]--> [Run LLM scorers]
        |
        v
[Aggregate across transcripts into EvalReport]
        |
        v
[Assert in vitest or output as report]
```

---

## Integration Points with Existing Architecture

### New Files and Directories

```
twining-mcp/
  plugin/
    BEHAVIORS.md                    # NEW: behavioral specification
  test/
    eval/
      types.ts                      # NEW: eval type definitions
      behaviors-parser.ts           # NEW: BEHAVIORS.md parser
      scenario-engine.ts            # NEW: synthetic scenario runner
      transcript-analyzer.ts        # NEW: JSONL transcript parser
      judge.ts                      # NEW: Claude API judge client
      report.ts                     # NEW: report generation
      scorers/
        index.ts                    # NEW: scorer registry
        assemble-before-decide.ts   # NEW: deterministic scorer
        verify-before-complete.ts   # NEW: deterministic scorer
        narrow-scope.ts             # NEW: deterministic scorer
        decision-quality.ts         # NEW: deterministic scorer
        warning-acknowledgment.ts   # NEW: deterministic scorer
        stop-hook-compliance.ts     # NEW: deterministic scorer
        coordination-protocol.ts    # NEW: deterministic scorer
        llm-rationale-quality.ts    # NEW: LLM-as-judge scorer
        llm-scope-appropriateness.ts# NEW: LLM-as-judge scorer
      scenarios/
        orient/                     # scenarios testing orient skill
        decide/                     # scenarios testing decide skill
        verify/                     # scenarios testing verify skill
        coordinate/                 # scenarios testing coordination
        anti-patterns/              # negative test scenarios
        workflows/                  # end-to-end multi-skill scenarios
      transcripts/                  # fixture transcripts for testing
      __tests__/                    # tests for the eval infrastructure itself
        behaviors-parser.test.ts
        scenario-engine.test.ts
        transcript-analyzer.test.ts
        scorers.test.ts
      synthetic.eval.ts             # NEW: vitest eval file for synthetic mode
      transcript.eval.ts            # NEW: vitest eval file for transcript mode
  vitest.config.eval.ts             # NEW: separate vitest config for evals
```

### Dependencies to Add

```json
{
  "devDependencies": {
    "@anthropic-ai/sdk": "^1.x.x"  // NEW: for LLM-as-judge API calls
  }
}
```

Note: `@anthropic-ai/sdk` is a devDependency only -- used exclusively in the eval harness, never in the MCP server runtime. Users who don't run evals never need it. `js-yaml` is already a production dependency and reused for scenario parsing.

### Zero Touch Points with Core Architecture

The eval system has **zero** imports from the MCP server:
- Does NOT import from `src/tools/`, `src/engine/`, or `src/storage/`
- Does NOT require a running MCP server instance
- Does NOT modify `.twining/` state
- ONLY reads: `plugin/BEHAVIORS.md`, `test/eval/scenarios/`, session JSONL files
- ONLY writes: stdout (vitest output), optionally `.planning/eval-results/`

This is deliberate. The existing 614 tests cover server correctness. The eval harness covers agent behavior quality. These are orthogonal concerns.

---

## Patterns to Follow

### Pattern 1: Grade Outcomes, Not Paths

**What:** Evaluate whether the agent achieved correct behavioral outcomes, not whether it took the exact expected sequence of calls.

**When:** Always. This is Anthropic's core guidance from "Demystifying evals for AI agents."

**Why:** Frontier models find creative solutions. An agent might call `twining_why` instead of `twining_assemble` to get context -- that is still orienting. Grading the path rigidly creates false negatives.

**Example:**
```typescript
// GOOD: checks outcome (context was gathered before deciding)
function assembleBeforeDecide(calls: ToolCall[]): boolean {
  for (const call of calls) {
    if (call.tool === 'twining_decide') {
      const priorContext = calls.some(
        c => ['twining_assemble', 'twining_why', 'twining_read'].includes(c.tool) &&
             c.timestamp < call.timestamp
      );
      if (!priorContext) return false;
    }
  }
  return true;
}

// BAD: checks exact sequence
function exactSequence(calls: ToolCall[]): boolean {
  return calls[0]?.tool === 'twining_assemble' &&
         calls[1]?.tool === 'twining_why' &&
         calls[2]?.tool === 'twining_decide';
}
```

### Pattern 2: Deterministic First, LLM-Judge for Nuance

**What:** Use deterministic scorers for structural checks; reserve LLM-as-judge for qualitative assessment.

**When:** Always design deterministic scorers first. Only add LLM-judge scorers when the behavioral rule cannot be checked structurally.

**Why:** Deterministic scorers are fast (ms), free, and 100% reproducible. LLM-judge scorers are slow (seconds), costly ($), and non-deterministic. Most behavioral rules (80%+) can be checked deterministically.

| Rule | Check Type | Reason |
|------|-----------|--------|
| "Assemble before decide" | Deterministic | Sequence check on tool call timeline |
| "Scope should be narrow" | Deterministic | Compare scope string against modified file paths |
| "Decision has alternatives" | Deterministic | Check `alternatives` array length > 0 |
| "Verify before complete" | Deterministic | Check for `twining_verify` in last N tool calls |
| "Decision rationale is high quality" | LLM-judge | Requires understanding natural language quality |
| "Finding is relevant to the work" | LLM-judge | Requires semantic understanding |

### Pattern 3: Small Scenario Set, High Signal

**What:** Start with 20-50 focused scenarios, not hundreds.

**When:** Initial eval development. Expand only when current scenarios fail to catch real behavioral failures.

**Why:** Per Anthropic: "early changes have large effect sizes and small sample sizes suffice." A well-chosen set of 30 scenarios covering the 8 skills and key anti-patterns provides high signal.

### Pattern 4: Scenario Categories Match Skills

**What:** Organize scenarios by the plugin skill they test, plus cross-cutting anti-patterns.

**Why:** When a scorer fails, you know exactly which skill file to tune.

```
scenarios/
  orient/           # tests twining-orient skill (3-5 scenarios)
  decide/           # tests twining-decide skill (3-5 scenarios)
  verify/           # tests twining-verify skill (3-5 scenarios)
  coordinate/       # tests twining-coordinate skill (2-3 scenarios)
  dispatch/         # tests twining-dispatch skill (2-3 scenarios)
  handoff/          # tests twining-handoff skill (2-3 scenarios)
  map/              # tests twining-map skill (2-3 scenarios)
  review/           # tests twining-review skill (2-3 scenarios)
  anti-patterns/    # negative scenarios (5-8 scenarios)
  workflows/        # multi-skill end-to-end (3-5 scenarios)
```

Total: ~30-45 scenarios.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Testing MCP Server Logic in Evals

**What:** Writing eval scenarios that test whether `twining_decide` correctly stores data or `twining_assemble` returns the right format.
**Why bad:** That is what the existing 614 unit/integration tests are for. Eval tests behavioral quality -- *when* and *how* tools are used, not *whether* they work correctly.
**Instead:** Eval assumes tools work correctly. It tests: "Given this session context, did the agent use the right tools in the right order with appropriate inputs?"

### Anti-Pattern 2: Real LLM Calls for Synthetic Scenarios

**What:** Actually calling Claude to "act as the agent" in synthetic scenarios, then judging the output.
**Why bad:** Expensive ($), slow (minutes per scenario), non-deterministic, and tests the model's behavior rather than the plugin's guidance quality.
**Instead:** Synthetic scenarios define the tool call sequence directly. Scorers evaluate the sequence against behavioral rules. This isolates plugin quality from model capability.

### Anti-Pattern 3: Monolithic Judge Prompt

**What:** Sending the entire transcript and all behavioral rules to a single LLM-judge call.
**Why bad:** Judge accuracy degrades with prompt length. Position bias causes rules at the end to be evaluated less carefully.
**Instead:** One judge call per LLM-scorer, with only the relevant rules and relevant tool calls. Short, focused prompts produce more reliable judgments.

### Anti-Pattern 4: Hard-Coding Transcript Format

**What:** Assuming a fixed JSONL schema for Claude Code transcripts.
**Why bad:** The format is not officially documented and changes between Claude Code versions.
**Instead:** Defensive parsing with type guards. Skip unrecognized lines. Log warnings for unexpected shapes. Test the parser against sample transcripts with fallback behavior.

### Anti-Pattern 5: Eval Specs Duplicating Skill Content

**What:** Copy-pasting SKILL.md content into BEHAVIORS.md or scenario files.
**Why bad:** Two sources of truth for the same information. They drift apart.
**Instead:** BEHAVIORS.md defines testable assertions *derived from* skills, not copies of skill text. Skills say "always assemble context first"; BEHAVIORS.md says `MUST: Call before any code modification`. The eval checks the MUST rule; the skill provides the guidance that leads agents to satisfy it.

---

## Scalability Considerations

| Concern | At 30 scenarios | At 100 scenarios | At 500+ scenarios |
|---------|-----------------|-------------------|-------------------|
| Deterministic eval time | <1s | <3s | <10s |
| LLM-judge eval time | ~30s (10 judge calls) | ~2min (30 calls) | Impractical without caching |
| LLM-judge cost | ~$0.05 | ~$0.15 | ~$0.75+ per run |
| Scenario maintenance | Easy | Moderate | High (needs deduplication) |
| CI integration | Every push | Every push (deterministic only) | Scheduled + manual trigger |

**Recommendation:** Stay at 30-50 scenarios. If more are needed, it means the behavioral spec needs refinement (fewer, clearer rules), not more test cases.

---

## Build Order (3 Phases)

### Phase 1: Behavioral Specification

**What:** Write `plugin/BEHAVIORS.md` with comprehensive rules for all 32 tools, 8 skills, and key workflows.

**Dependencies:** None -- this is pure documentation.

**Outputs:** `plugin/BEHAVIORS.md`, `test/eval/types.ts`, `test/eval/behaviors-parser.ts`.

**Why first:** Everything else depends on having rules to test against. The spec is also the most valuable artifact on its own -- even without the harness, it codifies what "good behavior" means.

### Phase 2: Eval Harness

**What:** Build scenario engine, transcript analyzer, scorers, and vitest integration.

**Dependencies:** Phase 1 (behavioral rules to score against).

**Sub-order within Phase 2:**
1. Types and scorer interface (`test/eval/types.ts`)
2. Behaviors parser + tests (`test/eval/behaviors-parser.ts`)
3. Deterministic scorers + tests (`test/eval/scorers/*.ts`)
4. Scenario engine + scenario YAML files (`test/eval/scenario-engine.ts`, `test/eval/scenarios/`)
5. Synthetic eval vitest file (`test/eval/synthetic.eval.ts`)
6. Transcript analyzer + tests (`test/eval/transcript-analyzer.ts`)
7. Transcript eval vitest file (`test/eval/transcript.eval.ts`)
8. LLM-as-judge module (`test/eval/judge.ts`) -- last because it requires API key
9. LLM-based scorers (`test/eval/scorers/llm-*.ts`)
10. Report module (`test/eval/report.ts`)

**Outputs:** Full eval harness, vitest config, npm scripts, initial 30-45 scenarios.

### Phase 3: Plugin Tuning

**What:** Run eval harness against current plugin, identify failures, iteratively tune plugin artifacts.

**Dependencies:** Phase 2 (eval harness to measure against).

**Process:**
1. Run `npm run eval` against current plugin (establish baseline score)
2. Identify highest-impact failures
3. Modify skill/hook/agent files
4. Re-run eval, measure improvement
5. Repeat until all deterministic scorers pass
6. Run LLM-judge scorers for qualitative check
7. Run against real transcripts (dogfood data from this repo's sessions)
8. Final polish pass

**Outputs:** Tuned plugin files, passing eval suite, eval results report.

---

## Testing the Eval System Itself

The eval harness needs its own unit tests (meta-testing):

```
test/eval/__tests__/
  behaviors-parser.test.ts    # parser correctly extracts rules from markdown
  scenario-engine.test.ts     # engine correctly loads and runs scenarios
  transcript-analyzer.test.ts # analyzer correctly parses JSONL samples
  scorers.test.ts             # each scorer produces correct results for known inputs
```

These are standard vitest unit tests included in the normal `vitest.config.ts` test pattern. They run in `npm test`. They ensure the eval infrastructure itself is correct before using it to evaluate the plugin.

---

## Sources

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) -- primary guidance on eval strategy, "grade outcomes not paths", 20-50 scenario recommendation, code vs LLM graders
- [Sentry vitest-evals](https://github.com/getsentry/vitest-evals) -- reference implementation for vitest-based LLM eval (architecture inspiration, not used as dependency)
- [LLM Evaluation in 2025](https://medium.com/@QuarkAndCode/llm-evaluation-in-2025-metrics-rag-llm-as-judge-best-practices-ad2872cfa7cb) -- LLM-as-judge patterns and bias mitigation
- [LLM-as-a-Judge: Complete Guide - Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge) -- judge prompt design, rubric structure
- [Amazon: Evaluating AI agents](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/) -- multi-level testing, golden datasets from historical logs
- [simonw/claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) -- JSONL transcript format reference
- [daaain/claude-code-log](https://github.com/daaain/claude-code-log) -- JSONL parsing patterns
- [Analyzing Claude Code Logs with DuckDB](https://liambx.com/blog/claude-code-log-analysis-with-duckdb) -- transcript field structure
- [Viteval](https://viteval.dev/) -- vitest-native eval framework (architecture reference)
- [Vercel AI SDK + Vitest evals](https://xata.io/blog/llm-evals-with-vercel-ai-and-vitest) -- practical vitest eval patterns
- [Bloom: automated behavioral evaluations](https://alignment.anthropic.com/2025/bloom-auto-evals/) -- Anthropic's own behavioral eval tooling
