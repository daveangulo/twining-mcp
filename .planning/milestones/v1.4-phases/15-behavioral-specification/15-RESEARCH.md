# Phase 15: Behavioral Specification - Research

**Researched:** 2026-03-02
**Domain:** Behavioral specification authoring + structured markdown parsing
**Confidence:** HIGH

## Summary

Phase 15 creates a single authoritative document (`plugin/BEHAVIORS.md`) that defines what correct Twining usage looks like for AI agents, covering all 32 MCP tools with MUST/SHOULD/MUST_NOT rules, workflow scenarios, anti-patterns, and quality criteria. The document must be machine-parseable so the eval harness (Phase 16) can extract rules and scenarios programmatically. Additionally, a TypeScript parser (`test/eval/behaviors-parser.ts`) must parse the spec into structured objects, validated by tests.

This phase is primarily a **content authoring** phase with a secondary **parser implementation** component. The content draws heavily from existing plugin skills (8 SKILL.md files already define workflows for orient, decide, verify, handoff, coordinate, map, review, dispatch) and the tool registration source code (32 tools across 8 files with full Zod schemas and descriptions). The hard constraint from STATE.md is the 8-12 MUST rule cap across all tools to prevent over-specification. The tiering system (Tier 1 core with full depth, Tier 2 supporting with lighter coverage) manages the scope to stay within this cap while covering all tools.

The parser is a straightforward markdown-to-structured-data pipeline. Given the project already uses TypeScript and vitest, the parser should use a line-by-line regex approach (no AST library needed) since the markdown format is fully controlled. The unified/remark ecosystem exists but is overkill for a controlled-format document where heading structure and table formats are deterministic.

**Primary recommendation:** Write BEHAVIORS.md in a strict, conventions-based markdown format with machine-readable section markers, then build a line-by-line parser that extracts rules, workflows, quality criteria, and anti-patterns into typed TypeScript interfaces.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SPEC-01 | plugin/BEHAVIORS.md contains behavioral rules (MUST/SHOULD/MUST_NOT) for all 32 MCP tools | Complete tool inventory of 32 tools documented; tiering strategy and rule cap (8-12 MUST) defined; existing skill files provide behavioral content |
| SPEC-02 | Each tool has usage context, correct usage examples, and incorrect usage examples | Tool descriptions from source provide usage context; existing skill SKILL.md files provide correct/incorrect usage patterns for Tier 1 tools |
| SPEC-03 | 8+ workflow scenarios define expected multi-tool sequences | 8 existing skill files map directly to 8 workflow scenarios (orient, decide, verify, handoff, coordinate, map, review, dispatch) |
| SPEC-04 | Anti-pattern catalog documents misuse | Existing skill files contain anti-pattern sections; tool descriptions contain "does NOT accept" guards |
| SPEC-05 | Tools tiered by importance with proportional spec depth | Tier 1/Tier 2 split researched; ~10 Tier 1 tools, ~22 Tier 2 tools based on usage frequency and workflow criticality |
| SPEC-06 | Spec uses structured markdown conventions machine-parseable by eval harness | Markdown format conventions and parser approach documented in Architecture Patterns |
| QUAL-01 | Per-tool quality criteria for parameter content | Parameter schemas from Zod definitions provide structural basis; quality criteria patterns documented |
| QUAL-02 | Scope precision rules | Existing skill files define scope conventions; narrowest-fit prefix pattern documented |
| QUAL-03 | Rationale quality criteria | twining_decide parameter schema shows required fields; quality criteria for rationale specificity documented |
| QUAL-04 | Quality anti-patterns documented | Anti-pattern catalog structure defined; concrete bad/good examples from existing skills |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (project version) | Parser implementation | Already the project language |
| vitest | (project version) | Parser test suite | Already the project test framework |
| zod | (project version) | Schema validation for parsed BEHAVIORS.md structures | Already used throughout project for tool input validation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | - | - | No additional libraries needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Line-by-line regex parser | unified/remark AST parser | AST parser is more robust for arbitrary markdown but overkill here -- BEHAVIORS.md format is fully controlled by us, regex is simpler, faster, zero new deps |
| Markdown tables for rules | YAML frontmatter blocks | YAML would be more structured but less human-readable; markdown tables are scannable by both humans and agents reading the file |
| JSON schema for parsed output | Plain TypeScript interfaces | JSON schema adds validation but Zod already handles runtime validation in this project |

**Installation:**
```bash
# No new dependencies needed -- all tools already in the project
```

## Architecture Patterns

### Recommended Project Structure
```
plugin/
  BEHAVIORS.md            # The behavioral specification (new)
test/eval/
  behaviors-parser.ts     # Parser: BEHAVIORS.md -> structured TypeScript objects (new)
  behaviors-parser.test.ts # Parser test suite (new)
  types.ts                # Shared types for parsed behavioral spec (new)
```

### Pattern 1: Structured Markdown Convention
**What:** A strict markdown format that is both human-readable and machine-parseable, using heading hierarchy, markdown tables, and code blocks with consistent conventions.
**When to use:** For BEHAVIORS.md content structure.
**Format:**

```markdown
# Behavioral Specification

## Tool Behaviors

### twining_decide
<!-- tier: 1 -->

#### Context
[When to use this tool]

#### Rules
| ID | Level | Rule |
|----|-------|------|
| DECIDE-01 | MUST | Record rationale with every decision |
| DECIDE-02 | MUST | Include at least one rejected alternative |
| DECIDE-03 | MUST_NOT | Use twining_post with entry_type "decision" instead of twining_decide |
| DECIDE-04 | SHOULD | Use narrowest scope that covers affected code |

#### Correct Usage
```json
{
  "domain": "architecture",
  "scope": "src/auth/",
  "summary": "Use JWT for stateless authentication",
  "rationale": "Enables horizontal scaling without session store...",
  "alternatives": [{"option": "Session cookies", "reason_rejected": "Requires sticky sessions"}]
}
```

#### Incorrect Usage
```json
{
  "domain": "implementation",
  "scope": "project",
  "summary": "Did the auth thing",
  "rationale": "seemed right",
  "alternatives": []
}
```
**Why incorrect:** Scope is "project" instead of "src/auth/", summary is vague, rationale lacks specificity, no alternatives provided.

## Workflows

### workflow: orient
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_status | Check project health |
| 2 | twining_assemble | Build task-specific context |
| 3 | twining_why | Understand decisions for target files |

## Anti-Patterns
### anti-pattern: fire-and-forget-decisions
**Description:** Recording decisions without linking commits or checking for conflicts
**Bad:**
[example]
**Good:**
[example]

## Quality Criteria
### quality: scope-precision
| Level | Description | Example |
|-------|-------------|---------|
| good | Narrowest path prefix | "src/auth/jwt.ts" |
| acceptable | Module-level prefix | "src/auth/" |
| bad | Overly broad | "project" |
```

### Pattern 2: Parser Architecture
**What:** A line-by-line state-machine parser that tracks heading depth and current section to extract structured data from the controlled markdown format.
**When to use:** For `test/eval/behaviors-parser.ts`.
**Example:**
```typescript
// Parser types
interface BehaviorSpec {
  tools: ToolBehavior[];
  workflows: WorkflowScenario[];
  antiPatterns: AntiPattern[];
  qualityCriteria: QualityCriterion[];
}

interface ToolBehavior {
  name: string;          // e.g., "twining_decide"
  tier: 1 | 2;
  context: string;       // usage context prose
  rules: BehaviorRule[];
  correctUsage?: CodeExample;
  incorrectUsage?: CodeExample;
  incorrectReason?: string;
}

interface BehaviorRule {
  id: string;            // e.g., "DECIDE-01"
  level: 'MUST' | 'SHOULD' | 'MUST_NOT';
  rule: string;
}

interface WorkflowScenario {
  name: string;          // e.g., "orient"
  steps: WorkflowStep[];
}

interface WorkflowStep {
  order: number;
  tool: string;
  purpose: string;
}

interface AntiPattern {
  id: string;
  description: string;
  badExample: string;
  goodExample: string;
}

interface QualityCriterion {
  name: string;          // e.g., "scope-precision"
  levels: QualityLevel[];
}

// Parser: line-by-line state machine
function parseBehaviors(markdown: string): BehaviorSpec {
  const lines = markdown.split('\n');
  // State: track current h2/h3/h4 section
  // Extract tables by detecting | header | row patterns
  // Extract code blocks by detecting ``` delimiters
  // Build structured output
}
```

### Pattern 3: Tiering Strategy
**What:** Tier 1 tools get full behavioral specification (context, rules, correct/incorrect examples). Tier 2 tools get lighter treatment (rules and anti-pattern only).
**When to use:** For organizing BEHAVIORS.md content.

**Tier 1 (Core -- ~10 tools, full depth):**
- `twining_assemble` -- gateway to all context
- `twining_post` -- primary blackboard interaction
- `twining_decide` -- core value proposition
- `twining_why` -- decision archaeology
- `twining_verify` -- pre-completion quality gate
- `twining_handoff` -- agent transition
- `twining_status` -- health check entry point
- `twining_add_entity` -- graph building
- `twining_add_relation` -- graph building
- `twining_read` -- blackboard querying

**Tier 2 (Supporting -- ~22 tools, lighter coverage):**
- `twining_query`, `twining_recent`, `twining_dismiss` (blackboard helpers)
- `twining_trace`, `twining_reconsider`, `twining_override`, `twining_promote`, `twining_commits`, `twining_search_decisions`, `twining_link_commit` (decision helpers)
- `twining_summarize`, `twining_what_changed` (context helpers)
- `twining_neighbors`, `twining_graph_query`, `twining_prune_graph` (graph helpers)
- `twining_agents`, `twining_register`, `twining_discover`, `twining_delegate`, `twining_acknowledge` (coordination helpers)
- `twining_archive`, `twining_export` (lifecycle helpers)

### Anti-Patterns to Avoid
- **Over-specification:** More than 12 MUST rules total leads to agents ignoring rules. Keep MUST count at 8-12 across all tools per STATE.md decision.
- **Spec-code drift:** BEHAVIORS.md must reference actual tool parameter names from Zod schemas, not invented ones.
- **Unparseable formatting:** Any deviation from the established heading/table conventions breaks the parser. Use a lint test to catch this.
- **Workflow combinatorial explosion:** Define 8-10 core workflow scenarios, not every possible tool combination.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown table parsing | Full markdown AST parser | Regex line-by-line extraction | Controlled format means simple regex works; AST adds ~5 deps |
| Schema validation of parsed output | Manual type checking | Zod schemas | Already used project-wide; runtime validation catches parser bugs |
| Rule ID generation | Auto-generated IDs | Hand-assigned IDs (DECIDE-01, POST-01) | IDs must be stable across parser runs and referenced by eval scenarios |

**Key insight:** The parser only needs to handle ONE document whose format we fully control. This is not a general-purpose markdown parser -- it is a format-specific extractor.

## Common Pitfalls

### Pitfall 1: Over-specifying MUST rules
**What goes wrong:** Too many MUST rules cause agents to either ignore most of them (information overload) or waste tokens on compliance checks.
**Why it happens:** Natural tendency to formalize every best practice as mandatory.
**How to avoid:** Hard cap of 8-12 MUST rules across all 32 tools (already decided in STATE.md). Use SHOULD for strong recommendations, reserve MUST for behaviors that would cause data corruption, coordination failures, or silent information loss.
**Warning signs:** If MUST count exceeds 12 during drafting, stop and demote the weakest ones to SHOULD.

### Pitfall 2: Spec-skill divergence
**What goes wrong:** BEHAVIORS.md says one thing, plugin SKILL.md files say another. Agents see conflicting guidance.
**Why it happens:** BEHAVIORS.md and skills are authored separately without cross-referencing.
**How to avoid:** BEHAVIORS.md should be the AUTHORITATIVE source; skill files are the DELIVERY mechanism. During Phase 19 (Plugin Tuning), skills get aligned to behaviors. For now, note divergences in the spec explicitly.
**Warning signs:** Workflow steps in BEHAVIORS.md that don't match skill workflow sections.

### Pitfall 3: Parser brittleness
**What goes wrong:** Parser breaks when someone adds a stray blank line or uses slightly different heading format.
**Why it happens:** Regex-based parsers are sensitive to whitespace and formatting variations.
**How to avoid:** (1) Include a "format lint" test that validates BEHAVIORS.md structure before parsing. (2) Make the parser tolerant of blank lines between sections. (3) Test against the ACTUAL file, not just synthetic fixtures.
**Warning signs:** Parser tests pass on fixtures but fail on the real file.

### Pitfall 4: Examples that don't match actual tool schemas
**What goes wrong:** "Correct usage" examples in BEHAVIORS.md use parameter names that don't exist in the actual Zod schema.
**Why it happens:** Writing examples from memory instead of referencing source code.
**How to avoid:** Cross-reference every example against the actual tool registration in `src/tools/*.ts`. Include a validation test that checks example parameter names against registered tool schemas.
**Warning signs:** Example JSON keys that differ from Zod schema field names.

### Pitfall 5: Workflows that are too prescriptive
**What goes wrong:** Workflow scenarios define exact tool sequences that don't account for real-world variation (e.g., "step 3 MUST be twining_why" but sometimes the agent already knows the decision history).
**Why it happens:** Trying to capture the ideal path as the only valid path.
**How to avoid:** Use SHOULD for workflow step ordering; use MUST only for critical invariants (e.g., "MUST call twining_assemble before twining_decide in a new scope").
**Warning signs:** Workflow scenarios that would fail eval for legitimate agent behavior variations.

## Code Examples

Verified patterns from the project source:

### Complete Tool Inventory (32 tools)
```
Blackboard (5):   twining_post, twining_read, twining_query, twining_recent, twining_dismiss
Decisions (9):    twining_decide, twining_why, twining_trace, twining_reconsider, twining_override,
                  twining_promote, twining_commits, twining_search_decisions, twining_link_commit
Context (3):      twining_assemble, twining_summarize, twining_what_changed
Graph (5):        twining_add_entity, twining_add_relation, twining_neighbors, twining_graph_query,
                  twining_prune_graph
Coordination (6): twining_agents, twining_register, twining_discover, twining_delegate,
                  twining_handoff, twining_acknowledge
Lifecycle (2):    twining_status, twining_archive
Verification (1): twining_verify
Export (1):       twining_export
```

### Existing Workflow Patterns from Skills (8 workflows)
```
1. Orient:     status -> assemble -> why -> [check warnings] -> [check handoffs]
2. Decide:     [identify scope] -> decide -> [post finding/warning] -> [handle conflicts]
                -> link_commit -> [promote]
3. Verify:     verify -> what_changed -> [link commits] -> post(status)
4. Handoff:    handoff -> [acknowledge] OR export -> summarize
5. Coordinate: agents -> discover -> delegate -> [monitor via recent/read]
6. Map:        add_entity -> add_relation -> neighbors -> [graph_query] -> [prune_graph]
7. Review:     what_changed -> trace -> search_decisions -> commits -> [link_commit] -> [decide]
8. Dispatch:   register -> delegate -> [Agent tool] -> handoff -> acknowledge
```

### Existing Anti-Patterns from Skills
```
From twining-decide SKILL.md:
- NEVER use twining_post with entry_type "decision" -- always use twining_decide
- NEVER skip alternatives -- even "do nothing" is a valid rejected alternative
- NEVER use "project" scope for a decision that only affects one module
- NEVER ignore conflict warnings -- resolve them explicitly

From twining-orient SKILL.md:
- Scope conventions: always use narrowest scope that fits
- Don't contradict active decisions without reconsider/override

From twining-verify SKILL.md:
- Must acknowledge or resolve warnings before saying "done"
```

### Markdown Table Parsing Example
```typescript
// Source: project convention
function parseMarkdownTable(lines: string[], startIdx: number): { headers: string[]; rows: string[][]; endIdx: number } {
  const headers = lines[startIdx]!.split('|').map(h => h.trim()).filter(Boolean);
  // Skip separator line (|---|---|---|)
  const rows: string[][] = [];
  let i = startIdx + 2;
  while (i < lines.length && lines[i]!.includes('|') && !lines[i]!.startsWith('#')) {
    const cells = lines[i]!.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length > 0) rows.push(cells);
    i++;
  }
  return { headers, rows, endIdx: i };
}
```

### Zod Schema for Parsed BehaviorSpec
```typescript
// Source: project convention (mirrors Zod patterns from src/tools/)
import { z } from 'zod';

const BehaviorRuleSchema = z.object({
  id: z.string().regex(/^[A-Z]+-\d+$/),
  level: z.enum(['MUST', 'SHOULD', 'MUST_NOT']),
  rule: z.string().min(10),
});

const ToolBehaviorSchema = z.object({
  name: z.string().startsWith('twining_'),
  tier: z.union([z.literal(1), z.literal(2)]),
  context: z.string().optional(),
  rules: z.array(BehaviorRuleSchema).min(1),
  correctUsage: z.string().optional(),
  incorrectUsage: z.string().optional(),
  incorrectReason: z.string().optional(),
});

const WorkflowStepSchema = z.object({
  order: z.number().int().positive(),
  tool: z.string().startsWith('twining_'),
  purpose: z.string(),
});

const WorkflowScenarioSchema = z.object({
  name: z.string(),
  steps: z.array(WorkflowStepSchema).min(2),
});

const AntiPatternSchema = z.object({
  id: z.string(),
  description: z.string(),
  badExample: z.string(),
  goodExample: z.string(),
});

const QualityLevelSchema = z.object({
  level: z.string(),
  description: z.string(),
  example: z.string(),
});

const QualityCriterionSchema = z.object({
  name: z.string(),
  levels: z.array(QualityLevelSchema).min(2),
});

export const BehaviorSpecSchema = z.object({
  tools: z.array(ToolBehaviorSchema).length(32),
  workflows: z.array(WorkflowScenarioSchema).min(8),
  antiPatterns: z.array(AntiPatternSchema).min(4),
  qualityCriteria: z.array(QualityCriterionSchema).min(3),
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Agent behavioral specs as prose-only docs | Machine-parseable specs that eval harnesses consume directly | 2025-2026 (spec-driven dev wave) | Enables automated evaluation against behavioral baselines |
| Monolithic eval prompts | Per-criterion focused judge calls | 2025 | More reliable LLM-as-judge scoring |
| Manual plugin tuning | Data-driven tuning via eval harness | 2025-2026 | Iterative improvement with regression detection |

**Deprecated/outdated:**
- N/A -- this is a novel system; no deprecated approaches to track

## Open Questions

1. **Exact MUST rule allocation across tools**
   - What we know: Hard cap of 8-12 MUST rules across all 32 tools (STATE.md decision). Most will cluster in Tier 1 tools.
   - What's unclear: The exact distribution. Should `twining_assemble` get 2 MUSTs and `twining_decide` get 3, or spread more evenly?
   - Recommendation: During BEHAVIORS.md authoring, draft all candidate MUST rules first, then rank-order by severity. Allocate top 8-12 as MUST, demote rest to SHOULD. Prioritize rules that prevent data corruption or coordination failures.

2. **Parser strictness vs. tolerance**
   - What we know: Parser must handle the real BEHAVIORS.md file reliably.
   - What's unclear: How strictly should the parser validate format? Should it warn or fail on unexpected formatting?
   - Recommendation: Strict parsing with clear error messages (line number + expected format). Parse errors should be test failures, not silent skips. This catches spec format drift early.

3. **Workflow scenario granularity**
   - What we know: Need 8+ scenarios. Existing 8 skills map to 8 natural scenarios.
   - What's unclear: Whether to add composite scenarios (e.g., "full task lifecycle" = orient + work + decide + verify) beyond the 8 skill-aligned ones.
   - Recommendation: Start with the 8 skill-aligned scenarios. Add 2-3 composite scenarios if natural ones emerge during authoring (e.g., "new session start-to-finish", "conflict resolution", "multi-agent delegation"). Target 10 total.

## Sources

### Primary (HIGH confidence)
- Project source code: `src/tools/*.ts` -- all 32 tool registrations with Zod schemas and descriptions
- Plugin skills: `plugin/skills/*/SKILL.md` -- 8 workflow definitions with anti-patterns
- Plugin agents: `plugin/agents/*.md` -- agent role definitions and tool access lists
- Plugin hooks: `plugin/hooks/` -- stop hook behavioral patterns
- `TWINING-DESIGN-SPEC.md` -- authoritative architecture reference (1041 lines)
- `.planning/STATE.md` -- 8-12 MUST rule hard cap decision
- `.planning/REQUIREMENTS.md` -- SPEC-01 through SPEC-06, QUAL-01 through QUAL-04

### Secondary (MEDIUM confidence)
- [GitHub Blog: Spec-Driven Development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-using-markdown-as-a-programming-language-when-building-with-ai/) -- industry pattern for machine-parseable markdown specs
- [remarkjs/remark](https://github.com/remarkjs/remark) -- markdown AST parser (evaluated but not recommended for this use case)

### Tertiary (LOW confidence)
- [Agent Harness patterns 2026](https://www.philschmid.de/agent-harness-2026) -- general agent eval patterns (not directly applicable but informative)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries needed; all tools already in project
- Architecture: HIGH -- format is fully controlled; parser approach is straightforward; existing skill content provides 80% of behavioral spec content
- Pitfalls: HIGH -- derived from direct analysis of project source and existing anti-patterns in skill files

**Research date:** 2026-03-02
**Valid until:** 2026-04-01 (stable -- content authoring phase, no external dependency risk)
