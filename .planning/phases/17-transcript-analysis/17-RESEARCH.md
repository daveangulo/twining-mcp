# Phase 17: Transcript Analysis - Research

**Researched:** 2026-03-02
**Domain:** Claude Code JSONL transcript parsing, eval harness integration
**Confidence:** HIGH

## Summary

Phase 17 parses real Claude Code session JSONL transcripts, extracts twining tool calls into the same `NormalizedToolCall`/`ScorerInput` format used by Phase 16's synthetic scenarios, and scores them with the same 7 deterministic scorers. This validates that synthetic scenarios match actual behavior patterns.

The Claude Code JSONL format has been thoroughly investigated by examining real transcripts from the project's own dogfooding sessions. The format is well-understood: each line is a JSON object with a `type` field (`assistant`, `user`, `progress`, `system`, `file-history-snapshot`, `queue-operation`). Tool calls live in `assistant` messages as content blocks with `type: "tool_use"`, and tool results appear in `user` messages as content blocks with `type: "tool_result"`. MCP tool names use prefixes (`mcp__twining__twining_post` or `mcp__plugin_twining_twining__twining_post`) that need normalization to the `twining_*` format scorers expect.

The existing eval infrastructure from Phase 16 is well-designed for extension. `ScorerInput` and `NormalizedToolCall` are format-agnostic. The transcript parser just needs to produce `ScorerInput` instances and the same `allScorers` array applies unchanged. A separate `vitest.config.transcript.ts` follows the `vitest.config.eval.ts` pattern.

**Primary recommendation:** Build a line-by-line JSONL parser that extracts tool_use blocks from assistant messages, normalizes MCP-prefixed names via `split('__').pop()`, pairs them with tool_result blocks via `tool_use_id`, and produces `ScorerInput` objects. Use Zod for runtime type validation of JSONL lines. Segment into workflow chunks using `twining_assemble` as boundary marker.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **JSONL parsing strategy**: Extract both `tool_use` content blocks AND `tool_result` content blocks from assistant messages. Follow `parentUuid` chains to include tool calls from subagent conversations. Handle malformed input defensively: skip unparseable JSON lines and collect warnings, never crash. Filter to only `twining_*` tool names after extraction.
- **Fixture sourcing**: Use full session transcripts as fixtures, not curated excerpts. Build an automated scrubbing script (`scripts/scrub-transcript.ts`) that strips sensitive content while preserving structural data. Select mixed quality sessions (well-used and poorly-used). At least 2 fixture files.
- **Scorer compatibility**: Segment transcripts into identifiable workflow chunks. Extend `NormalizedToolCall` with optional `result` field. Use separate (lower) pass/fail thresholds for transcript evals vs synthetic scenarios. Include session-level and workflow-level metadata in ScorerInput.
- **CLI and test runner**: Separate vitest config file (`vitest.config.transcript.ts`) with `npm run eval:transcript`. Use a manifest file (JSON) to list fixtures with metadata. Standalone scrubbing script run as prep step.

### Claude's Discretion
- Memory strategy for JSONL loading (load full file vs streaming) -- pick simplest approach that handles typical session sizes
- Fixture file location within test/eval/ directory structure
- Reporter approach for transcript eval output (reuse existing or extend)
- Exact workflow segmentation heuristics (how to detect workflow boundaries beyond assemble calls)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EVAL-04 | Transcript parser extracts twining_* tool calls from Claude Code JSONL session logs | JSONL format fully characterized (5 message types, tool_use in assistant blocks, MCP prefix normalization via `split('__').pop()`, tool_result pairing via tool_use_id). Zod schema for runtime validation. |
| EVAL-05 | Same scorers work on both synthetic scenarios and real transcripts | ScorerInput interface is format-agnostic. Transcript parser produces identical `{ calls, metadata }` shape. All 7 scorers in `allScorers` accept ScorerInput without modification. Only NormalizedToolCall needs optional `result` field addition. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^3.25.0 | Runtime validation of JSONL line structure | Already used for ScenarioSchema; same pattern for transcript lines |
| vitest | ^4.0.18 | Test runner for transcript eval suite | Already configured for eval; new config file follows existing pattern |
| node:fs | built-in | Synchronous file reading of JSONL fixtures | Transcripts are 0.3-7MB; readFileSync is simple and sufficient |
| node:readline | built-in | Line-by-line JSONL parsing | Alternative to split('\n'); handles edge cases |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| js-yaml | ^4.1.0 | Already a dependency | Not needed for this phase (JSON manifest, not YAML) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| readFileSync + split | readline stream | Streaming not needed for 7MB max; readFileSync is simpler and synchronous |
| JSON manifest | YAML manifest | JSON is simpler for typed fixtures; YAML adds no value here |
| Custom line parser | JSONStream library | Extra dependency; line-by-line JSON.parse handles JSONL trivially |

**Installation:**
No new dependencies needed. Everything uses existing zod, vitest, and node built-ins.

## Architecture Patterns

### Recommended Project Structure
```
test/eval/
  transcript-analyzer.ts          # Core parser: JSONL -> ScorerInput[]
  transcript-analyzer.test.ts     # Unit tests for parser
  transcript-runner.eval.ts       # Vitest eval runner (like eval-runner.eval.ts)
  transcript-manifest.json        # Fixture manifest with metadata
  fixtures/                       # Directory for scrubbed transcript JSONL files
    session-good-workflow.jsonl    # Well-used session fixture
    session-poor-workflow.jsonl    # Poorly-used session fixture
  results/
    latest.json                   # Synthetic results (existing)
    transcript-latest.json        # Transcript results (new)
scripts/
  scrub-transcript.ts             # Standalone scrubbing script
vitest.config.transcript.ts       # Separate vitest config
```

### Pattern 1: JSONL Line Parser with Zod Validation
**What:** Parse each JSONL line independently, validate with Zod, collect warnings for malformed lines, never crash.
**When to use:** Every transcript file load operation.
**Example:**
```typescript
// Source: Verified against real Claude Code JSONL transcripts
import { z } from "zod";

// Minimal schema for lines we care about (assistant with tool_use)
const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()).default({}),
});

const AssistantLineSchema = z.object({
  type: z.literal("assistant"),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(z.union([
      ToolUseBlockSchema,
      z.object({ type: z.string() }).passthrough(), // text blocks, etc.
    ])),
  }),
});

// Minimal schema for tool_result matching
const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([
    z.string(),
    z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  ]).optional(),
  is_error: z.boolean().optional(),
});

const UserLineSchema = z.object({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(z.union([
        ToolResultBlockSchema,
        z.object({ type: z.string() }).passthrough(),
      ])),
    ]),
  }),
});
```

### Pattern 2: MCP Tool Name Normalization
**What:** Normalize MCP-prefixed tool names to bare `twining_*` format.
**When to use:** During extraction, before filtering.
**Example:**
```typescript
// Source: Verified against 275 real tool calls across all project transcripts
// Two known patterns:
//   mcp__twining__twining_decide
//   mcp__plugin_twining_twining__twining_decide
// Both normalize to: twining_decide

function normalizeMcpToolName(rawName: string): string {
  const parts = rawName.split("__");
  return parts[parts.length - 1] ?? rawName;
}

function isTwiningTool(normalizedName: string): boolean {
  return normalizedName.startsWith("twining_");
}
```

### Pattern 3: Tool Call + Result Pairing
**What:** Match tool_use blocks to their tool_result blocks via `tool_use_id`.
**When to use:** When building NormalizedToolCall with optional result field.
**Example:**
```typescript
// Source: Verified JSONL structure - tool_use has `id`, tool_result has `tool_use_id`
interface ExtractedToolCall {
  id: string;           // tool_use block id (e.g. "toolu_01Nuj2VpKkF4Sr1FgaW4EivB")
  name: string;         // normalized name (e.g. "twining_post")
  input: Record<string, unknown>;
  timestamp?: string;
}

interface ExtractedToolResult {
  toolUseId: string;    // matches ExtractedToolCall.id
  content: string | null;
  isError: boolean;
}

// First pass: collect all tool_use calls
// Second pass: collect all tool_result blocks into a Map<toolUseId, result>
// Third pass: merge
```

### Pattern 4: Workflow Segmentation
**What:** Split transcript tool calls into workflow segments at `twining_assemble` boundaries.
**When to use:** Before scoring, to produce per-workflow ScorerInput instances.
**Example:**
```typescript
// Workflow segments: assemble marks the start of a new workflow context
// If no assemble calls, the entire session is one segment
function segmentByWorkflow(
  calls: NormalizedToolCall[]
): { calls: NormalizedToolCall[]; startIndex: number }[] {
  const segments: { calls: NormalizedToolCall[]; startIndex: number }[] = [];
  let current: NormalizedToolCall[] = [];
  let startIndex = 0;

  for (const call of calls) {
    if (call.tool === "twining_assemble" && current.length > 0) {
      segments.push({ calls: current, startIndex });
      current = [];
      startIndex = call.index;
    }
    current.push(call);
  }
  if (current.length > 0) {
    segments.push({ calls: current, startIndex });
  }
  return segments;
}
```

### Pattern 5: Manifest-Based Fixture Loading
**What:** JSON manifest lists fixtures with metadata instead of bare glob discovery.
**When to use:** In transcript-runner.eval.ts to load and describe fixtures.
**Example:**
```typescript
// test/eval/transcript-manifest.json
interface TranscriptFixture {
  file: string;            // relative path to fixture JSONL
  description: string;     // human-readable session description
  expectedQuality: "good" | "poor" | "mixed"; // expected overall quality
  tags: string[];          // e.g. ["orient", "decide", "full-lifecycle"]
  sessionId?: string;      // original session ID (for traceability)
}

interface TranscriptManifest {
  fixtures: TranscriptFixture[];
  thresholds?: {
    default: number;       // lower than synthetic's 0.8
  };
}
```

### Anti-Patterns to Avoid
- **Crashing on malformed JSONL lines:** Real transcripts contain edge cases. Always try/catch individual lines and collect warnings.
- **Assuming array content in tool_result:** 87% of tool_result content is a plain string, not an array. Handle both `string` and `{type: "text", text: string}[]` formats.
- **Filtering by `twining_` before normalization:** Raw names use MCP prefixes. Normalize first, then filter.
- **Using synthetic scenario thresholds:** Real sessions are messier. Use lower thresholds (e.g., 0.6 default vs 0.8 for synthetic).
- **Treating the whole session as one workflow:** Large sessions contain multiple independent workflows. Segment at `twining_assemble` boundaries.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSONL line validation | Custom field checking | Zod schemas with `.safeParse()` | Consistent with existing pattern; `.safeParse()` returns `{success, data, error}` without throwing |
| Scorer pipeline | Custom scorer loop | Existing `allScorers` array + same loop pattern from `eval-runner.eval.ts` | Scorers already handle arbitrary ScorerInput; no modification needed |
| Results JSON format | New format | Same format as `eval-runner.eval.ts` afterAll hook | Enables reporter reuse |
| Vitest config | Custom test harness | `vitest.config.transcript.ts` following `vitest.config.eval.ts` | Proven pattern; vitest handles discovery and reporting |

**Key insight:** Phase 16 built the eval infrastructure to be format-agnostic. The only new code is the parser that converts JSONL to ScorerInput. Everything downstream (scorers, aggregation, reporting) is reusable as-is.

## Common Pitfalls

### Pitfall 1: tool_result Content Format Variation
**What goes wrong:** Parser assumes tool_result content is always an array of `{type: "text", text: string}` objects, but 87% of actual results are plain strings.
**Why it happens:** The Anthropic API docs show array format, but Claude Code serializes results in multiple formats depending on the tool type.
**How to avoid:** Handle three content formats: `string`, `{type: "text", text: string}[]`, and `undefined`/`null` (empty results).
**Warning signs:** Type errors when accessing `.content[0].text` on a string value.

### Pitfall 2: MCP Tool Name Prefix Variation
**What goes wrong:** Parser only handles one prefix pattern and misses tools from the other.
**Why it happens:** Two naming conventions exist: `mcp__twining__twining_*` (direct MCP server) and `mcp__plugin_twining_twining__twining_*` (plugin MCP server). Which pattern appears depends on how the Twining server was configured.
**How to avoid:** Use `split('__').pop()` which handles both patterns. All 275 observed twining tool calls normalize correctly with this approach.
**Warning signs:** Missing tool calls in parsed output; call count lower than expected.

### Pitfall 3: Confusing parentUuid with Subagent Chains
**What goes wrong:** Parser tries to follow `parentUuid` to find subagent tool calls but finds only linked conversation messages, not isolated subagent sessions.
**Why it happens:** CONTEXT.md mentions following `parentUuid` chains for subagent conversations, but real JSONL shows all messages (including subagent spawned via Agent tool) share the same sessionId and appear in the same file. `parentUuid` links conversation messages chronologically, not across agent boundaries. `isSidechain` is the subagent marker, but no sidechain messages were observed in real transcripts for this project.
**How to avoid:** Parse ALL assistant messages in the JSONL file regardless of `parentUuid`. Filter by tool name only. If `isSidechain` messages appear in future sessions, include them -- they use the same content block format.
**Warning signs:** Implementing complex parentUuid traversal logic that adds no value.

### Pitfall 4: Empty or Tiny Fixtures
**What goes wrong:** Fixtures have too few twining calls for scorers to produce meaningful results.
**Why it happens:** Many real sessions only have 1-3 twining calls. Scorers return vacuous passes (score 1.0) for empty check arrays.
**How to avoid:** Select fixtures with 5+ twining tool calls. The sessions with the most calls identified in research: `0564752a` (79 calls), `2087835c` (13 calls), `89f734b3` (12 calls), `20d78311` (12 calls), `9773c459` (12 calls), `46f0c3f0` (10 calls).
**Warning signs:** All scorer results showing 1.0 with empty checks arrays.

### Pitfall 5: Sensitive Data in Fixtures
**What goes wrong:** Real transcripts contain file contents, user prompts, file paths, and environment details that get committed to the repo.
**Why it happens:** Copying transcripts directly without scrubbing.
**How to avoid:** The scrubbing script (`scripts/scrub-transcript.ts`) is a locked decision. It must run before fixtures enter the repo. Strip: file contents in Read/Write results, user message text, file paths (replace with generic), env vars.
**Warning signs:** `git diff` showing real file contents or user prompts in fixture files.

### Pitfall 6: Error tool_results Breaking the Parser
**What goes wrong:** Parser doesn't handle `is_error: true` tool results, or treats them as missing results.
**Why it happens:** 198 error results observed across all sessions (about 4% of total). These have string content with error messages.
**How to avoid:** Include error results in the `result` field of NormalizedToolCall. Mark with `isError: true`. Scorers currently ignore the result field, but Phase 18's LLM judge will use it.
**Warning signs:** Missing result pairings for tool calls that did execute but failed.

## Code Examples

### Complete JSONL Line Types (verified from real transcripts)
```typescript
// Source: Examined 117 JSONL files from ~/.claude/projects/-Users-dave-Code-twining-mcp/
// All observed top-level message types:
type JournalLineType =
  | "assistant"              // Model responses with content blocks
  | "user"                   // User messages and tool results
  | "system"                 // System prompts
  | "progress"              // Hook progress, tool progress events
  | "file-history-snapshot"  // File state snapshots
  | "queue-operation";       // Subagent task results

// Common fields on most line types:
interface JournalLineBase {
  type: JournalLineType;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
}
```

### Assistant Message with Tool Use (verified structure)
```typescript
// Source: Real transcript 8f4bf61f-e44e-4611-b2cd-b650693fa07c.jsonl
interface AssistantMessage {
  type: "assistant";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  isSidechain: boolean;
  message: {
    model: string;
    role: "assistant";
    content: ContentBlock[];  // tool_use and text blocks
    stop_reason: string | null;
    usage: Record<string, unknown>;
  };
}

type ContentBlock =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "text"; text: string };
```

### User Message with Tool Result (verified structure)
```typescript
// Source: Real transcript analysis across 4984 tool_result blocks
interface UserToolResultMessage {
  type: "user";
  uuid: string;
  parentUuid: string;        // Points to assistant message UUID
  message: {
    role: "user";
    content: ToolResultBlock[] | string;
  };
  toolUseResult?: unknown;   // Redundant copy; dict (79%), list[dict] (9%), string (5%)
  sourceToolAssistantUUID?: string;  // Links back to assistant message
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;       // Matches tool_use block `id`
  content: string | TextBlock[] | undefined;  // THREE formats observed
  is_error?: boolean;        // Present and true on ~4% of results
}

interface TextBlock {
  type: "text";
  text: string;
}
```

### Transcript Parser Core Function
```typescript
// Pseudocode for the main parse function
interface ParseResult {
  segments: ScorerInput[];    // One per workflow segment
  sessionMeta: {
    sessionId: string;
    totalLines: number;
    twinningCallCount: number;
    parseWarnings: string[];
  };
}

function parseTranscript(jsonlContent: string): ParseResult {
  const lines = jsonlContent.split("\n").filter(Boolean);
  const toolCalls: ExtractedToolCall[] = [];
  const toolResults = new Map<string, ExtractedToolResult>();
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Step 1: Safe JSON parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      warnings.push(`Line ${i}: invalid JSON`);
      continue;
    }

    // Step 2: Extract tool_use from assistant messages
    // Step 3: Extract tool_result from user messages
    // Step 4: Normalize MCP names, filter to twining_*
  }

  // Step 5: Pair calls with results
  // Step 6: Segment into workflows
  // Step 7: Build ScorerInput per segment
}
```

### Scrubbing Script Pattern
```typescript
// scripts/scrub-transcript.ts
// Key fields to scrub:
// - user message content (replace with "[scrubbed]")
// - tool_result content for non-twining tools (replace text)
// - file paths (replace /Users/xxx/... with /project/...)
// - system messages (may contain CLAUDE.md contents)
// Preserve:
// - message type and structure
// - tool_use name and input for twining_ tools
// - tool_result for twining_ tools (these are the eval data)
// - timestamps, uuids, parentUuids (structural data)
// - sessionId
```

### Vitest Config Pattern
```typescript
// vitest.config.transcript.ts
// Source: Follows vitest.config.eval.ts pattern
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/eval/**/*.transcript.ts"],
    testTimeout: 30000,
    reporters: ["default", "./test/eval/eval-reporter.ts"],  // reuse existing
  },
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual transcript review | Automated scorer pipeline | Phase 16 (current) | Scorers ready for any ScorerInput source |
| Synthetic-only eval | Synthetic + real transcript eval | Phase 17 (this phase) | Validates synthetic scenarios against reality |
| twining_ tool names only | MCP-prefixed names in transcripts | Claude Code MCP integration | Parser must normalize names |

**Deprecated/outdated:**
- The `eval:transcript` npm script currently echoes a placeholder. Will be replaced with actual vitest command.

## Open Questions

1. **Workflow boundary detection beyond assemble**
   - What we know: `twining_assemble` is the clearest workflow start marker (context loading before work begins).
   - What's unclear: Should `twining_status` also mark a boundary? What about long gaps between tool calls?
   - Recommendation: Start with `twining_assemble` only. Add time-gap heuristic (e.g., 5+ minute gap = new segment) if needed during Phase 19 tuning. Keep it simple for now.

2. **Transcript threshold calibration**
   - What we know: Synthetic scenarios use DEFAULT_THRESHOLD=0.8. Real sessions are messier.
   - What's unclear: Exact threshold that separates "good" from "poor" real sessions.
   - Recommendation: Start with 0.6 for transcript evals. The manifest's `expectedQuality` field enables per-fixture threshold overrides. Phase 19 will tune based on actual results.

3. **Subagent (isSidechain) messages**
   - What we know: No sidechain messages observed in any current project transcripts. All twining tool calls appear in the main conversation thread.
   - What's unclear: Whether future sessions using Agent tool delegation will produce sidechain twining calls.
   - Recommendation: Parse all lines regardless of `isSidechain` value. The same content block format applies. This is defensive and costs nothing.

## Sources

### Primary (HIGH confidence)
- **Real JSONL transcripts** - Examined 117 transcript files from `~/.claude/projects/-Users-dave-Code-twining-mcp/`, totaling 275 twining tool call instances across 35 sessions. Verified message types, content block formats, tool naming patterns, tool_result variations, file sizes.
- **Existing eval code** - `test/eval/scenario-schema.ts`, `test/eval/scorer-types.ts`, `test/eval/scorers/index.ts`, `test/eval/eval-runner.eval.ts`, `test/eval/eval-reporter.ts` -- all read and analyzed for integration patterns.
- **vitest.config.eval.ts** - Pattern for separate vitest configs, verified working.
- **package.json** - Confirmed existing scripts, dependencies (zod ^3.25.0, vitest ^4.0.18).

### Secondary (MEDIUM confidence)
- Claude Code JSONL format is not officially documented by Anthropic (noted as blocker/concern in STATE.md). However, direct examination of 117 real transcript files provides high empirical confidence in the format.

### Tertiary (LOW confidence)
- None. All findings verified against real transcripts.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all patterns verified against existing code
- Architecture: HIGH -- parser pattern verified against real JSONL, scorer integration verified against existing interfaces
- Pitfalls: HIGH -- all pitfalls discovered from real transcript analysis, not theoretical
- JSONL format: HIGH (empirical) / MEDIUM (official) -- format not officially documented but thoroughly characterized from 117 real files

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable -- JSONL format unlikely to change; eval infra is project-controlled)
