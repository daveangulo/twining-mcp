# Phase 16: Eval Harness -- Deterministic Core - Research

**Researched:** 2026-03-02
**Domain:** Vitest eval harness, YAML scenario engine, deterministic scorers
**Confidence:** HIGH

## Summary

Phase 16 builds a standalone eval system that loads YAML scenarios, runs them through deterministic scorers, and reports per-scenario pass/fail results via vitest. The system is entirely separate from the main test suite (separate vitest config, separate npm scripts) and uses only existing dependencies (vitest 4.0.18, js-yaml 4.1.0, zod 3.25.0). No new libraries are needed.

The foundation already exists: `test/eval/types.ts` defines BehaviorSpec schemas, `test/eval/behaviors-parser.ts` parses BEHAVIORS.md into typed objects, and `plugin/BEHAVIORS.md` contains 32 tool behaviors, 10 workflows, 5 anti-patterns, and 4 quality criteria. Phase 16 adds the scenario format (Zod-validated YAML), 7 category scorers, 20+ scenarios, a custom vitest reporter, and the `vitest.config.eval.ts` config.

**Primary recommendation:** Build the system bottom-up: normalized types and scenario schema first, then the scenario loader, then individual scorers with their own test files, then the vitest test runner that wires scenarios to scorers, and finally the custom reporter. Each layer is independently testable.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Flat tool list: each scenario has a simple array of `tool_calls` with tool name + arguments -- scorers infer patterns from the sequence
- Calls only, no mock responses -- scorers evaluate structural patterns in the call sequence, not reactions to responses
- Per-scorer expectations: each scenario declares `expected_scores` mapping scorer names to pass/fail, so a scenario can be good on sequencing but bad on scope narrowness
- Light metadata: `name`, `description`, `category`, `tags` array for filtering, `tool_calls`, `expected_scores`
- Zod schema validates all YAML scenarios at load time
- 7 category scorers covering logical groupings: sequencing, scope quality, argument quality, decision hygiene, workflow completeness, anti-patterns, quality criteria
- Each scorer returns both numeric 0-1 score AND individual check pass/fail with details -- numeric for thresholds/trends, checks for diagnostics
- Hybrid rule mapping: scorers reference parsed BehaviorSpec for rule metadata (IDs, levels, descriptions) but implement check logic inline with custom functions
- Weighted severity: MUST violations score 0, SHOULD violations score 0.5, MUST_NOT violations score 0 -- aggregated to category score
- Format-agnostic scorer interface: accepts normalized tool call sequences so same scorers work on transcript data in Phase 17
- Vitest handles test execution, then custom reporter prints summary table with per-category scores, overall pass rate, and worst-performing scenarios
- JSON results written to `test/eval/results/latest.json` after each run for programmatic comparison
- Global default threshold (0.8) with per-scenario override via `expected_scores`
- One YAML file per scenario in flat `test/eval/scenarios/` directory, named by category prefix
- All 5 core workflow categories: orient, decide, verify, coordinate, handoff (~4-5 scenarios each)
- Balanced ~50/50 happy-path vs violation scenarios
- Mix of short focused scenarios (2-3 calls testing specific rules) and longer realistic workflows (5-8 calls testing full sequences)
- 20+ scenarios total across all categories

### Claude's Discretion
- Exact scorer implementation details and helper functions
- Normalized tool call interface shape (as long as it's format-agnostic)
- Vitest config structure for eval suite isolation
- Summary table formatting details
- JSON results schema details

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EVAL-01 | Synthetic scenario engine loads YAML definitions and runs through scorer pipeline | Scenario loader using js-yaml + Zod validation, scorer pipeline with normalized tool call interface, vitest test runner wiring |
| EVAL-02 | 7+ deterministic scorers check structural behavioral patterns (sequencing, arguments, ordering) | 7 category scorers (sequencing, scope, argument, decision hygiene, workflow completeness, anti-patterns, quality criteria) with BehaviorSpec hybrid rule mapping |
| EVAL-08 | 20+ synthetic scenarios across all workflow categories | Flat YAML files in test/eval/scenarios/ covering orient, decide, verify, coordinate, handoff categories with ~4-5 each |
| EVAL-09 | Separate vitest config (vitest.config.eval.ts) and npm scripts (eval, eval:synthetic, eval:transcript) | vitest --config flag for isolated config, package.json script additions |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | 4.0.18 | Test runner for eval suite | Already installed, supports --config for isolated config files |
| js-yaml | 4.1.0 | YAML scenario loading | Already a production dependency, used in src/config.ts |
| zod | 3.25.0 | Runtime validation of YAML scenarios | Already used extensively, established pattern in types.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| vitest/reporters | 4.0.18 (bundled) | Custom summary reporter | Extending BaseReporter for eval results table |
| node:fs | built-in | File I/O for scenario loading and results writing | Loading YAML files, writing latest.json |
| node:path | built-in | Path resolution | Resolving scenario directory paths |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| js-yaml | yaml (npm) | js-yaml is already installed; no reason to add another YAML library |
| Custom reporter | vitest-evals | vitest-evals compatibility with vitest 4.x is unverified (noted in STATE.md); custom reporter is ~30 lines and fully controlled |
| Zod for scenario schemas | Manual validation | Zod already established in this codebase; provides type inference for free |

**Installation:**
```bash
# No new dependencies needed -- all libraries already installed
```

## Architecture Patterns

### Recommended Project Structure
```
test/eval/
  types.ts                    # [EXISTS] BehaviorSpec Zod schemas + interfaces
  behaviors-parser.ts         # [EXISTS] State-machine parser for BEHAVIORS.md
  behaviors-parser.test.ts    # [EXISTS] Parser tests
  scenario-schema.ts          # [NEW] Zod schema for YAML scenario format + normalized types
  scenario-loader.ts          # [NEW] Loads + validates YAML scenarios from disk
  scenario-loader.test.ts     # [NEW] Loader tests
  scorer-types.ts             # [NEW] Scorer interface, ScorerResult, CheckResult types
  scorers/
    sequencing.ts             # [NEW] Workflow step ordering checks
    scope-quality.ts          # [NEW] Scope precision checks
    argument-quality.ts       # [NEW] Parameter content quality checks
    decision-hygiene.ts       # [NEW] Decision workflow pattern checks
    workflow-completeness.ts  # [NEW] Full workflow coverage checks
    anti-patterns.ts          # [NEW] Anti-pattern detection checks
    quality-criteria.ts       # [NEW] Quality criteria compliance checks
    index.ts                  # [NEW] Exports all scorers as registry
  scorers.test.ts             # [NEW] Scorer unit tests (or co-located per scorer)
  eval-runner.ts              # [NEW] Orchestrates scenario -> scorer pipeline
  eval-reporter.ts            # [NEW] Custom vitest reporter for summary table
  results/
    latest.json               # [NEW, generated] Latest eval results
  scenarios/
    orient-happy-path.yaml    # [NEW] ~20+ scenario files
    orient-no-assemble.yaml
    decide-happy-path.yaml
    ...
vitest.config.eval.ts         # [NEW] Separate eval vitest config at project root
```

### Pattern 1: Normalized Tool Call Interface
**What:** A format-agnostic representation of a tool call sequence that scorers accept. This decouples scorers from both YAML scenario format and future transcript format.
**When to use:** Always -- scorers never see the raw scenario or transcript data.
**Example:**
```typescript
// The normalized interface scorers consume
interface NormalizedToolCall {
  tool: string;           // e.g. "twining_decide"
  arguments: Record<string, unknown>;  // tool call arguments
  index: number;          // position in sequence (0-based)
}

interface ScorerInput {
  calls: NormalizedToolCall[];
  metadata?: Record<string, unknown>;  // optional scenario/transcript metadata
}
```

### Pattern 2: Scorer Interface with Dual Output
**What:** Each scorer returns both a numeric 0-1 score AND individual check results with rule IDs traced back to BEHAVIORS.md.
**When to use:** All 7 category scorers implement this interface.
**Example:**
```typescript
interface CheckResult {
  ruleId: string;         // e.g. "DECIDE-01", "POST-02"
  level: "MUST" | "SHOULD" | "MUST_NOT";
  passed: boolean;
  message: string;        // human-readable explanation
}

interface ScorerResult {
  scorer: string;         // scorer category name
  score: number;          // 0-1 numeric score
  passed: boolean;        // score >= threshold
  checks: CheckResult[];  // individual check details
}

interface Scorer {
  name: string;
  score(input: ScorerInput, spec: BehaviorSpec): ScorerResult;
}
```

### Pattern 3: Weighted Severity Aggregation
**What:** MUST/MUST_NOT violations score 0, SHOULD violations score 0.5, passes score 1. Category score is the weighted mean.
**When to use:** Inside each scorer's `score()` method.
**Example:**
```typescript
function aggregateChecks(checks: CheckResult[]): number {
  if (checks.length === 0) return 1.0;
  const scores = checks.map(c => {
    if (c.passed) return 1.0;
    if (c.level === "MUST" || c.level === "MUST_NOT") return 0;
    return 0.5; // SHOULD violation
  });
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
```

### Pattern 4: Scenario-Driven Test Generation
**What:** Each YAML scenario becomes a vitest test case. The eval test file dynamically loads scenarios and generates `it()` blocks per scenario per scorer.
**When to use:** The main eval test runner file.
**Example:**
```typescript
// test/eval/eval.test.ts
import { describe, it, expect } from "vitest";
import { loadScenarios } from "./scenario-loader";
import { allScorers } from "./scorers";
import { parseBehaviors } from "./behaviors-parser";

const scenarios = loadScenarios();
const spec = parseBehaviors(fs.readFileSync("plugin/BEHAVIORS.md", "utf-8"));

for (const scenario of scenarios) {
  describe(scenario.name, () => {
    for (const scorer of allScorers) {
      it(`${scorer.name}`, () => {
        const result = scorer.score(
          { calls: scenario.tool_calls, metadata: { category: scenario.category } },
          spec
        );
        const expected = scenario.expected_scores[scorer.name];
        if (expected !== undefined) {
          expect(result.passed).toBe(expected);
        }
      });
    }
  });
}
```

### Pattern 5: YAML Scenario Format
**What:** Each scenario is a single YAML file with Zod-validated structure.
**When to use:** All 20+ scenario files follow this format.
**Example:**
```yaml
name: orient-happy-path
description: Agent correctly orients by checking status, assembling context, then reviewing decisions
category: orient
tags: [gate-1, tier-1-tools, happy-path]
tool_calls:
  - tool: twining_status
    arguments: {}
  - tool: twining_assemble
    arguments:
      scope: "src/auth/"
      max_tokens: 4000
  - tool: twining_why
    arguments:
      file_paths: ["src/auth/jwt.ts"]
expected_scores:
  sequencing: true
  scope_quality: true
  argument_quality: true
  workflow_completeness: true
  anti_patterns: true
```

### Anti-Patterns to Avoid
- **Coupling scorers to scenario format:** Scorers must accept normalized tool call sequences, not raw YAML objects. If a scorer imports scenario-specific types, it cannot work on transcripts later.
- **Importing from src/:** The eval system is orthogonal to the MCP server. Zero imports from `src/tools/`, `src/engine/`, `src/storage/`. Only `test/eval/` internal imports and `plugin/BEHAVIORS.md` (read as text).
- **Hardcoding rule IDs in scorers:** Scorers should reference BehaviorSpec for rule metadata. If a rule ID changes in BEHAVIORS.md, the scorer should pick it up automatically.
- **Testing scorer logic only through scenarios:** Scorer unit tests should test individual check functions in isolation, not only through the full scenario pipeline.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML parsing | Custom YAML parser | js-yaml 4.1.0 (already installed) | YAML spec is complex; js-yaml handles edge cases |
| Schema validation | Manual field checks | Zod schemas | Zod provides type inference, clear error messages, composability |
| Test runner/framework | Custom test harness | vitest with `--config` | vitest handles concurrency, reporting hooks, watch mode |
| Result formatting | Console.log scattered output | Custom vitest Reporter extending BaseReporter | Reporter lifecycle gives structured access to all test results |

**Key insight:** The eval system is a thin orchestration layer over existing, well-tested infrastructure. The only genuinely new code is the scorer check logic itself.

## Common Pitfalls

### Pitfall 1: Circular dependency between scorers and scenario schema
**What goes wrong:** Scorers import scenario types directly, creating a coupling that breaks format-agnostic design.
**Why it happens:** It's tempting to pass the full scenario object to scorers.
**How to avoid:** Define `NormalizedToolCall` and `ScorerInput` in `scorer-types.ts`. The scenario loader normalizes YAML into this format. Scorers only import from `scorer-types.ts` and `types.ts` (BehaviorSpec).
**Warning signs:** A scorer file importing from `scenario-schema.ts`.

### Pitfall 2: Vitest __dirname resolution in ESM
**What goes wrong:** `__dirname` is not available in ESM modules. The behaviors-parser test already uses it (vitest provides it), but new code might assume it works outside vitest.
**Why it happens:** The project uses `"type": "module"` in package.json and `"module": "nodenext"` in tsconfig.
**How to avoid:** In vitest test files, `__dirname` is shimmed and works. In non-test code, use `import.meta.url` with `fileURLToPath`. The scenario loader can use `import.meta.url` or accept a directory path parameter.
**Warning signs:** `ReferenceError: __dirname is not defined` at runtime.

### Pitfall 3: Scenario expected_scores completeness
**What goes wrong:** A scenario doesn't declare expected_scores for all scorers, and the test either skips silently or fails unexpectedly.
**Why it happens:** Scenarios only need to declare expectations for scorers whose behavior they specifically test.
**How to avoid:** Make the test runner skip scoring when `expected_scores` doesn't include a scorer name, rather than asserting. This is intentional -- a scope-focused scenario doesn't need to declare expectations about sequencing.
**Warning signs:** Tests failing on scorers that aren't relevant to the scenario's purpose.

### Pitfall 4: BehaviorSpec loading performance
**What goes wrong:** Every test file independently parses BEHAVIORS.md, slowing the suite.
**Why it happens:** Each `describe` block or test file reads and parses the file.
**How to avoid:** Parse BehaviorSpec once in a shared setup file or use vitest's `globalSetup`. The existing pattern in `behaviors-parser.test.ts` uses `beforeAll` which is good -- apply the same pattern in the eval runner.
**Warning signs:** Eval suite taking >5 seconds when it should take <1 second.

### Pitfall 5: Score threshold boundary conditions
**What goes wrong:** A scorer returns exactly 0.8 and the comparison `score >= threshold` vs `score > threshold` causes flaky results.
**Why it happens:** Floating point arithmetic with weighted averages.
**How to avoid:** Use `>=` consistently (score passes if >= threshold). Round scores to 4 decimal places to avoid floating point drift. Document the convention.
**Warning signs:** Tests passing/failing inconsistently on the same scenario.

## Code Examples

Verified patterns from project codebase and official docs:

### YAML Loading with js-yaml (project pattern)
```typescript
// Source: src/config.ts (existing project code)
import yaml from "js-yaml";
import fs from "node:fs";

function loadYaml<T>(filePath: string): T {
  const content = fs.readFileSync(filePath, "utf-8");
  return yaml.load(content) as T;
}
```

### Zod Schema Validation (project pattern)
```typescript
// Source: test/eval/types.ts (existing project code)
import { z } from "zod";

const ScenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(["orient", "decide", "verify", "coordinate", "handoff"]),
  tags: z.array(z.string()).default([]),
  tool_calls: z.array(z.object({
    tool: z.string().startsWith("twining_"),
    arguments: z.record(z.unknown()).default({}),
  })).min(1),
  expected_scores: z.record(z.boolean()).default({}),
});

type Scenario = z.infer<typeof ScenarioSchema>;
```

### Vitest Separate Config (from vitest docs)
```typescript
// vitest.config.eval.ts
// Source: https://vitest.dev/config/
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/eval/**/*.eval.ts"],
    testTimeout: 30000,
    reporters: ["default", "./test/eval/eval-reporter.ts"],
  },
});
```

### Custom Vitest Reporter (from vitest docs)
```typescript
// Source: https://vitest.dev/guide/advanced/reporters
import { BaseReporter } from "vitest/reporters";
import type { TestModule } from "vitest/node";

export default class EvalReporter extends BaseReporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    // Access test results and print summary table
    for (const testModule of testModules) {
      for (const task of testModule.children) {
        console.log(task.type, task.fullName);
      }
    }
  }
}
```

### Dynamic Test Generation (vitest pattern)
```typescript
// Source: vitest docs + project test conventions
import { describe, it, expect, beforeAll } from "vitest";

// Load data outside describe -- vitest collects before running
const scenarios = loadAllScenarios();

describe("eval suite", () => {
  let spec: BehaviorSpec;
  beforeAll(() => {
    spec = parseBehaviors(fs.readFileSync("plugin/BEHAVIORS.md", "utf-8"));
  });

  for (const scenario of scenarios) {
    describe(scenario.name, () => {
      // Generate per-scorer tests for this scenario
    });
  }
});
```

## 7 Scorer Categories -- Detailed Design

Based on the CONTEXT.md decisions and BEHAVIORS.md content:

### 1. Sequencing Scorer
**Checks:** Tool call ordering matches workflow patterns from BEHAVIORS.md workflows.
**Rules referenced:** Workflow step sequences (orient, decide, verify, etc.)
**Example checks:**
- orient workflow: status before assemble before why
- decide workflow: assemble before decide
- verify workflow: verify before what_changed
**Violation example:** Calling twining_decide without prior twining_assemble

### 2. Scope Quality Scorer
**Checks:** Scope parameters use narrow path prefixes, not "project".
**Rules referenced:** POST-03, READ-01, ASSEMBLE-01 (SHOULD rules about scope narrowness), anti-pattern scope-inflation
**Example checks:**
- No tool call uses scope "project" when a narrower path exists
- Scope values look like file paths (contain "/" or ".")

### 3. Argument Quality Scorer
**Checks:** Tool call arguments are populated, specific, and match field purposes.
**Rules referenced:** POST-01, POST-04, DECIDE-01, DECIDE-02, quality criteria (parameter-content, rationale-quality)
**Example checks:**
- summary fields are under 200 chars
- entry_type matches content semantics
- rationale field is present and non-trivial for decide calls

### 4. Decision Hygiene Scorer
**Checks:** Decision-related workflow patterns are complete.
**Rules referenced:** DECIDE-01, DECIDE-02, DECIDE-03, LINKCOMMIT-01, anti-pattern fire-and-forget-decisions, anti-pattern blind-decisions
**Example checks:**
- twining_decide followed by twining_link_commit (not fire-and-forget)
- twining_assemble called before twining_decide (not blind)
- Alternatives provided in decide calls

### 5. Workflow Completeness Scorer
**Checks:** Multi-step workflows include all expected steps.
**Rules referenced:** Workflow definitions from BEHAVIORS.md
**Example checks:**
- orient workflow includes all 3 steps (status, assemble, why)
- handoff workflow includes verify before handoff
- Session lifecycle hits all key steps

### 6. Anti-Patterns Scorer
**Checks:** Known anti-patterns are absent (or present in violation scenarios).
**Rules referenced:** Anti-pattern catalog from BEHAVIORS.md (fire-and-forget, scope-inflation, rationale-poverty, blackboard-spam, blind-decisions)
**Example checks:**
- No fire-and-forget pattern (decide without link_commit)
- No scope-inflation (broad scopes)
- No rationale-poverty (vague rationale text)

### 7. Quality Criteria Scorer
**Checks:** Tool arguments meet quality criteria levels.
**Rules referenced:** Quality criteria from BEHAVIORS.md (scope-precision, rationale-quality, parameter-content, alternative-depth)
**Example checks:**
- Scope precision is "good" or "acceptable"
- Rationale quality is not "bad"
- Parameter content fields are populated meaningfully

## Scenario Coverage Plan

Based on BEHAVIORS.md 5 core workflow categories plus cross-cutting concerns:

| Category | Happy Path | Violation | Total | Key Rules Tested |
|----------|------------|-----------|-------|------------------|
| orient | 2 | 2 | 4 | Sequencing, scope precision, assembly |
| decide | 2 | 3 | 5 | Decision hygiene, alternatives, rationale quality |
| verify | 2 | 2 | 4 | Workflow completeness, link_commit |
| coordinate | 2 | 1 | 3 | Sequencing, capability matching |
| handoff | 2 | 2 | 4 | Verify-before-handoff, acknowledgment |
| cross-cutting | 1 | 1 | 2 | Full lifecycle, anti-pattern combos |
| **Total** | **11** | **11** | **22** | |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| vitest-evals library | Custom reporter (~30 LOC) | vitest 4.x compatibility unverified | Avoids dependency risk; full control |
| Vitest workspace files | `--config` flag | Stable since vitest 1.x | Simpler than workspace for two configs |
| Manual test result aggregation | BaseReporter.onTestRunEnd | vitest 4.x | Structured access to all test results |

**Deprecated/outdated:**
- vitest `workspace` files: overkill for just two config files (main + eval). The `--config` flag is simpler.
- `Reporter` interface changed in vitest 4.x: methods now receive `TestModule` objects instead of raw `File` arrays. Use the vitest 4.x API.

## Open Questions

1. **Exact vitest 4.x Reporter API surface**
   - What we know: BaseReporter exists with `onTestRunEnd(testModules)` and `onTestModuleCollected()`. Reporter interface is optional-method.
   - What's unclear: Full set of available lifecycle hooks in vitest 4.x specifically, and the exact `TestModule` / task tree structure for accessing individual test results programmatically.
   - Recommendation: Start with a minimal reporter using `onTestRunEnd`. If more hooks are needed, extend incrementally. The reporter is a nice-to-have detail -- vitest's default reporter already shows pass/fail. The custom reporter adds the summary table.

2. **Scorer relevance per scenario**
   - What we know: Not all 7 scorers apply to every scenario. A coordinate scenario might not have meaningful decision hygiene checks.
   - What's unclear: Whether to skip non-applicable scorers or score them as 1.0 (pass by default).
   - Recommendation: Use `expected_scores` as the authoritative map. If a scorer isn't in `expected_scores`, the test simply skips that assertion. The scorer still runs (for the summary report) but doesn't affect pass/fail.

## Sources

### Primary (HIGH confidence)
- `test/eval/types.ts` - Existing BehaviorSpec schemas and interfaces
- `test/eval/behaviors-parser.ts` - Existing parser implementation
- `plugin/BEHAVIORS.md` - Authoritative behavioral specification (768 lines, 32 tools, 10 workflows, 5 anti-patterns, 4 quality criteria)
- `vitest.config.ts` - Existing vitest configuration
- `package.json` - Installed dependencies (vitest 4.0.18, js-yaml 4.1.0, zod 3.25.0)

### Secondary (MEDIUM confidence)
- [Vitest Configuration docs](https://vitest.dev/config/) - `--config` flag, `defineConfig`, `test.include`
- [Vitest Custom Reporter docs](https://vitest.dev/guide/advanced/reporters) - BaseReporter extension, Reporter interface, lifecycle hooks
- [Vitest Reporter config](https://vitest.dev/config/reporters) - Reporter array configuration

### Tertiary (LOW confidence)
- vitest 4.x Reporter API exact method signatures -- verified conceptually but specific `TestModule` tree traversal patterns need validation during implementation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all dependencies already installed and used in the project
- Architecture: HIGH - pattern follows established project conventions (Zod, vitest, js-yaml)
- Pitfalls: HIGH - based on direct analysis of project codebase (ESM, __dirname, etc.)
- Scorer design: MEDIUM - 7 categories locked by user decision; exact check logic is implementation detail
- Reporter API: MEDIUM - vitest 4.x reporter surface partially verified from docs

**Research date:** 2026-03-02
**Valid until:** 2026-04-01 (stable stack, no fast-moving dependencies)
