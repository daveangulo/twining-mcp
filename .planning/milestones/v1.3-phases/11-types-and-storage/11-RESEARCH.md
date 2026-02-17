# Phase 11: Types and Storage - Research

**Researched:** 2026-02-17
**Domain:** Data models and persistence layer for agent coordination
**Confidence:** HIGH

## Summary

Phase 11 introduces two new data domains to Twining: agent registry and handoff records. Both follow established storage patterns already proven across blackboard, decisions, and graph subsystems. The agent registry is a single JSON file with upsert semantics (like graph entities). Handoff records use the individual-file-plus-JSONL-index pattern (like decisions). No new libraries are needed; all infrastructure exists.

The core design challenge is defining data models that are minimal enough for Phase 11 but provide the query surface that Phases 12-14 need. Agent discovery requires filtering by capability tags and sorting by liveness. Handoff retrieval requires filtering by source/target agent and scope. Context assembly (Phase 13) needs to include handoff results. The dashboard (Phase 14) needs to list agents with status and handoffs with acknowledgment state.

**Primary recommendation:** Follow the DecisionStore pattern for handoffs (individual JSON files + JSONL index) and the GraphStore entity pattern for agent registry (single JSON file with upsert). Extend `init.ts` to create `agents/` and `handoffs/` directories. Add new interfaces to `types.ts`. Write store classes that mirror existing naming and API conventions exactly.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Capability tags:** Free-form strings (locked by REG-03 and out-of-scope decision on taxonomy)
- **Liveness states:** Three states: active/idle/gone (locked by REG-04)
- **Handoff shape:** IDs and summaries, not full context serialization (locked by out-of-scope decision)
- **Prior decisions:** Delegations are blackboard entries with structured metadata (not a separate queue); Liveness inferred from last_active timestamp (no heartbeat protocol); Handoff records store IDs and summaries

### Claude's Discretion
All four areas delegated entirely:
- **Agent identity:** ID format, auto-register behavior, re-registration semantics, additional metadata fields
- **Capability tags:** Tag granularity model, normalization rules, tag limits
- **Liveness thresholds:** Default thresholds for active->idle and idle->gone, configurability, gone cleanup strategy
- **Handoff record shape:** Results structure, context snapshot scope, scope field, JSONL index design

Design goals: follow existing Twining patterns, serve Phases 12-14 query needs, stay minimal, be consistent with ULID/file-native/JSONL conventions.

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| REG-01 | Agent auto-registers on first Twining tool call with agent_id and timestamp | AgentRecord type with `registered_at` and `last_active` timestamps; AgentStore.upsert() method handles both auto-register and explicit register |
| REG-02 | Agent can explicitly register with capabilities, role, and description via twining_register | AgentRecord includes `capabilities: string[]`, `role?: string`, `description?: string` fields; upsert semantics merge new data |
| REG-03 | Agent can declare capability tags as free-form strings | `capabilities` field is `string[]` with lowercase-trim normalization; no taxonomy, no validation beyond type |
| REG-04 | Agent liveness status inferred from last activity timestamp (active/idle/gone) | `computeLiveness(last_active, now, thresholds)` pure function; configurable thresholds in config.yml with sensible defaults |
| HND-05 | Handoff records persist across sessions (file-native storage) | HandoffStore with individual JSON files in `.twining/handoffs/` and JSONL index at `.twining/handoffs/index.jsonl`; mirrors DecisionStore pattern |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| proper-lockfile | ^4.1.2 | Advisory file locking for concurrent writes | Already used by all existing stores |
| ulid | ^3.0.2 | Temporally sortable unique IDs | Project convention, all IDs are ULIDs |
| vitest | ^4.0.18 | Test framework | Already configured for project |

### Supporting
No new libraries needed. This phase uses only existing project dependencies.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Single registry.json | JSONL for agents | JSON preferred: small dataset (<50 agents typical), need random access/upsert, same pattern as graph entities.json |
| Individual handoff JSON files | Single JSONL | Individual files preferred: mirrors decision pattern, enables reading single handoff without parsing entire file, supports context snapshots that may be large |

**Installation:**
No new packages needed.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── utils/
│   └── types.ts              # Add AgentRecord, HandoffRecord, AgentLiveness, HandoffIndexEntry
├── storage/
│   ├── init.ts               # Extend to create agents/ and handoffs/ directories
│   ├── agent-store.ts         # NEW: Agent registry CRUD (single JSON file)
│   └── handoff-store.ts       # NEW: Handoff record CRUD (individual files + JSONL index)
```

```
.twining/
├── agents/
│   └── registry.json          # Array of AgentRecord objects
├── handoffs/
│   ├── index.jsonl            # Append-only index for fast listing/filtering
│   └── {ulid}.json            # Individual handoff records with full detail
```

### Pattern 1: AgentStore — Single JSON File with Upsert (like GraphStore entities)

**What:** Agent registry stored as a JSON array in a single file. Upsert by agent_id (not name+type like entities).
**When to use:** Small collections (<100 items) that need random access and in-place updates.
**Why this pattern:** Agent count is bounded (typically 1-10 per project). Full registry fits easily in memory. Upsert semantics needed for auto-register + explicit register.

```typescript
// Mirrors GraphStore.addEntity pattern
export class AgentStore {
  private readonly registryPath: string;

  constructor(twiningDir: string) {
    this.registryPath = path.join(twiningDir, "agents", "registry.json");
  }

  /** Register or update an agent. Upsert by agent_id. */
  async upsert(input: {
    agent_id: string;
    capabilities?: string[];
    role?: string;
    description?: string;
  }): Promise<AgentRecord> {
    this.ensureFile();
    const release = await lockfile.lock(this.registryPath, LOCK_OPTIONS);
    try {
      const agents = JSON.parse(fs.readFileSync(this.registryPath, "utf-8")) as AgentRecord[];
      const now = new Date().toISOString();
      const existing = agents.find(a => a.agent_id === input.agent_id);

      if (existing) {
        // Merge: update last_active, merge capabilities, update role/description if provided
        existing.last_active = now;
        if (input.capabilities) {
          existing.capabilities = [...new Set([...existing.capabilities, ...normalizeTags(input.capabilities)])];
        }
        if (input.role !== undefined) existing.role = input.role;
        if (input.description !== undefined) existing.description = input.description;
        fs.writeFileSync(this.registryPath, JSON.stringify(agents, null, 2));
        return existing;
      }

      // Create new
      const agent: AgentRecord = {
        agent_id: input.agent_id,
        capabilities: normalizeTags(input.capabilities ?? []),
        role: input.role,
        description: input.description,
        registered_at: now,
        last_active: now,
      };
      agents.push(agent);
      fs.writeFileSync(this.registryPath, JSON.stringify(agents, null, 2));
      return agent;
    } finally {
      await release();
    }
  }

  /** Touch last_active timestamp for an agent. Creates minimal record if not exists. */
  async touch(agentId: string): Promise<void> { /* ... */ }

  /** Get all agents, optionally with computed liveness. */
  async getAll(): Promise<AgentRecord[]> { /* ... */ }

  /** Find agents by capability tags (OR match with substring). */
  async findByCapabilities(tags: string[]): Promise<AgentRecord[]> { /* ... */ }
}
```

### Pattern 2: HandoffStore — Individual Files + JSONL Index (like DecisionStore)

**What:** Each handoff is a JSON file in `.twining/handoffs/{ulid}.json`. A JSONL index at `index.jsonl` enables fast listing without reading every file.
**When to use:** Records that grow over time, may contain substantial detail, need individual access.
**Why this pattern:** Handoff records include context snapshots (lists of decision/warning IDs and summaries) that could be sizable. Individual files allow reading just one handoff. JSONL index is append-only for fast writes.

```typescript
// Mirrors DecisionStore pattern
export class HandoffStore {
  private readonly handoffsDir: string;
  private readonly indexPath: string;

  constructor(twiningDir: string) {
    this.handoffsDir = path.join(twiningDir, "handoffs");
    this.indexPath = path.join(this.handoffsDir, "index.jsonl");
  }

  /** Create a new handoff record. Writes file and appends to index. */
  async create(input: Omit<HandoffRecord, "id" | "created_at">): Promise<HandoffRecord> {
    const record: HandoffRecord = {
      ...input,
      id: generateId(),
      created_at: new Date().toISOString(),
    };
    const filePath = path.join(this.handoffsDir, `${record.id}.json`);
    await writeJSON(filePath, record);

    // Append to JSONL index (just metadata, not full record)
    await appendJSONL(this.indexPath, toIndexEntry(record));
    return record;
  }

  /** Get a single handoff by ID. */
  async get(id: string): Promise<HandoffRecord | null> { /* ... */ }

  /** List handoffs by filter (uses JSONL index for fast scan). */
  async list(filters?: { source_agent?: string; target_agent?: string; scope?: string; since?: string; limit?: number }): Promise<HandoffIndexEntry[]> { /* ... */ }

  /** Update acknowledgment status. Rewrites individual file. */
  async acknowledge(id: string, acknowledgedBy: string): Promise<void> { /* ... */ }
}
```

### Pattern 3: Liveness Computation — Pure Function

**What:** A stateless function that computes liveness from timestamps and thresholds.
**When to use:** Every time agent list is queried or displayed.
**Why this pattern:** No state mutation, easy to test, thresholds come from config or defaults.

```typescript
export type AgentLiveness = "active" | "idle" | "gone";

export interface LivenessThresholds {
  idle_after_ms: number;   // ms since last_active before "idle" (default: 5 min)
  gone_after_ms: number;   // ms since last_active before "gone" (default: 30 min)
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  idle_after_ms: 5 * 60 * 1000,    // 5 minutes
  gone_after_ms: 30 * 60 * 1000,   // 30 minutes
};

export function computeLiveness(
  lastActive: string,
  now: Date,
  thresholds: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): AgentLiveness {
  const elapsed = now.getTime() - new Date(lastActive).getTime();
  if (elapsed < thresholds.idle_after_ms) return "active";
  if (elapsed < thresholds.gone_after_ms) return "idle";
  return "gone";
}
```

### Anti-Patterns to Avoid
- **Heartbeat polling:** Out of scope. MCP has no push channel. Liveness is inferred from `last_active` timestamp updated on any tool call.
- **Agent ID as ULID:** Agent IDs should be agent-provided strings (like `"main"`, `"researcher-1"`, `"planner"`), not server-generated ULIDs. The agent names itself; the server tracks it.
- **Full context in handoffs:** Do not serialize full blackboard entries or decision bodies in handoff records. Store IDs and summaries only. The consumer can call `twining_assemble` or `twining_why` to get full context.
- **Separate delegation queue:** Delegations are blackboard entries with structured metadata, not a separate storage domain. Phase 11 does NOT need a delegation store.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File locking | Custom lock mechanism | `proper-lockfile` (already in deps) | Race conditions in concurrent agent writes |
| ID generation | Custom IDs or UUIDs | `ulid` via `generateId()` (already exists) | Temporal sortability, project convention |
| JSON file I/O | Direct fs calls | `readJSON`/`writeJSON`/`appendJSONL`/`readJSONL` from file-store.ts | Locking, error handling, directory creation |
| Tag normalization | Complex NLP | Simple `toLowerCase().trim()` | Free-form tags, no taxonomy needed (REG-03) |

**Key insight:** Every storage primitive needed (locked JSON read/write, JSONL append/read, directory creation) already exists in `file-store.ts`. The new stores compose these primitives exactly like existing stores do.

## Common Pitfalls

### Pitfall 1: Overcomplicating Agent Identity
**What goes wrong:** Building a complex registration flow with validation, uniqueness checks across sessions, or server-generated IDs.
**Why it happens:** Instinct to treat agent identity like user auth.
**How to avoid:** Agent ID is a simple string the agent provides. If it calls any Twining tool with `agent_id: "foo"`, that agent is registered/touched. `twining_register` just adds richer metadata.
**Warning signs:** If you're building a "registration ceremony" with multiple steps, you've overcomplicated it.

### Pitfall 2: JSONL Index Out of Sync with Files
**What goes wrong:** Index says a handoff exists but the JSON file was deleted or corrupted. Or a file exists but wasn't indexed.
**Why it happens:** Two-step write (file + index) isn't atomic.
**How to avoid:** Always write file first, then index. On read, if index references a missing file, skip it gracefully (log warning, don't throw). The DecisionStore already handles this pattern.
**Warning signs:** Tests that only check index without verifying file, or vice versa.

### Pitfall 3: Liveness Thresholds That Don't Match Usage Patterns
**What goes wrong:** Setting idle threshold too short (agent appears "gone" during normal work pauses) or too long (stale agents appear "active").
**Why it happens:** Guessing without understanding Claude Code agent lifecycles.
**How to avoid:** Default to 5 min idle, 30 min gone. These are generous for tool-call-driven workflows. Make thresholds configurable in config.yml so users can tune.
**Warning signs:** Agents flickering between states during normal operation.

### Pitfall 4: Forgetting to Extend init.ts
**What goes wrong:** New directories aren't created on fresh project init, causing "directory not found" errors on first use.
**Why it happens:** Adding store code but forgetting to update the initialization.
**How to avoid:** Success criteria #4 explicitly requires init extensions. Test with a fresh temp directory.
**Warning signs:** Tests pass (because they manually create directories) but real usage fails.

### Pitfall 5: Capability Tag Deduplication
**What goes wrong:** Agent registers with `["testing", "Testing", "TESTING"]` and gets three "different" capabilities.
**Why it happens:** No normalization.
**How to avoid:** Normalize tags: `tag.toLowerCase().trim()`. Deduplicate with `Set`. Apply on write, not just on read.
**Warning signs:** Agent capability lists with near-duplicate entries.

## Code Examples

### Agent Record Type
```typescript
// Source: follows existing types.ts patterns (BlackboardEntry, Decision, Entity)
export interface AgentRecord {
  agent_id: string;              // Agent-provided identifier (e.g., "main", "researcher-1")
  capabilities: string[];        // Free-form tags, normalized lowercase (REG-03)
  role?: string;                 // Optional role description (e.g., "planner", "reviewer")
  description?: string;          // Optional human-readable description
  registered_at: string;         // ISO 8601 — first seen
  last_active: string;           // ISO 8601 — last tool call
}
```

### Handoff Record Type
```typescript
// Source: follows DecisionStore individual-file pattern
export interface HandoffRecord {
  id: string;                    // ULID
  created_at: string;            // ISO 8601
  source_agent: string;          // Agent ID that created the handoff
  target_agent?: string;         // Optional: intended recipient agent ID
  scope?: string;                // Optional: codebase area (prefix-matchable like decision scopes)
  summary: string;               // One-line summary of what was handed off
  results: HandoffResult[];      // Structured results with status
  context_snapshot: {            // Referenced IDs and summaries (not full objects)
    decision_ids: string[];      // Active decision IDs relevant to handoff
    warning_ids: string[];       // Active warning IDs relevant to handoff
    finding_ids: string[];       // Recent finding IDs relevant to handoff
    summaries: string[];         // Human-readable summaries of key context
  };
  acknowledged_by?: string;      // Agent ID that acknowledged receipt
  acknowledged_at?: string;      // ISO 8601 — when acknowledged
}

export interface HandoffResult {
  description: string;           // What was accomplished
  status: "completed" | "partial" | "blocked" | "failed";
  artifacts?: string[];          // File paths or references produced
  notes?: string;                // Additional context
}
```

### Handoff Index Entry Type
```typescript
// Lightweight entry for JSONL index — fast listing without reading full files
export interface HandoffIndexEntry {
  id: string;
  created_at: string;
  source_agent: string;
  target_agent?: string;
  scope?: string;
  summary: string;
  result_status: string;         // Aggregate: "completed" | "partial" | "blocked" | "failed" | "mixed"
  acknowledged: boolean;
}
```

### Init Extension
```typescript
// Source: extend existing initTwiningDir in src/storage/init.ts
// Add after existing directory creation:
fs.mkdirSync(path.join(twiningDir, "agents"), { recursive: true });
fs.mkdirSync(path.join(twiningDir, "handoffs"), { recursive: true });

// Add after existing empty data files:
fs.writeFileSync(
  path.join(twiningDir, "agents", "registry.json"),
  JSON.stringify([], null, 2),
);
// Note: handoffs/index.jsonl starts empty (no file needed — appendJSONL creates it)
```

### Liveness Computation
```typescript
// Pure function, easy to test in isolation
export type AgentLiveness = "active" | "idle" | "gone";

export interface LivenessThresholds {
  idle_after_ms: number;
  gone_after_ms: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  idle_after_ms: 5 * 60 * 1000,     // 5 minutes
  gone_after_ms: 30 * 60 * 1000,    // 30 minutes
};

export function computeLiveness(
  lastActive: string,
  now: Date = new Date(),
  thresholds: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): AgentLiveness {
  const elapsed = now.getTime() - new Date(lastActive).getTime();
  if (elapsed < thresholds.idle_after_ms) return "active";
  if (elapsed < thresholds.gone_after_ms) return "idle";
  return "gone";
}
```

### Tag Normalization
```typescript
/** Normalize capability tags: lowercase, trim, deduplicate */
export function normalizeTags(tags: string[]): string[] {
  const normalized = tags.map(t => t.toLowerCase().trim()).filter(t => t.length > 0);
  return [...new Set(normalized)];
}
```

### Test Pattern (follows existing conventions)
```typescript
// Source: mirrors test/decision-store.test.ts setup
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentStore } from "../src/storage/agent-store.js";

let tmpDir: string;
let store: AgentStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-agent-store-test-"));
  fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "agents", "registry.json"),
    JSON.stringify([]),
  );
  store = new AgentStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

## Design Recommendations (Claude's Discretion Areas)

### Agent Identity: Agent-Provided Strings
**Recommendation:** `agent_id` is a string provided by the agent. Not a ULID, not server-generated.
**Rationale:** Agents need stable identifiers across sessions. "main", "researcher", "planner" are meaningful. ULIDs are opaque and change each session. The field name `agent_id` already exists in BlackboardEntry and Decision types — reuse the same semantics.
**Auto-register:** On first Twining tool call, if `agent_id` doesn't exist in registry, create a minimal record with just `agent_id`, `registered_at`, and `last_active`. If it does exist, touch `last_active`.
**Re-registration:** Upsert semantics. Calling `twining_register` with the same `agent_id` merges capabilities (union), overwrites role/description if provided, updates `last_active`.

### Capability Tags: Mixed Granularity, Normalized
**Recommendation:** No limits on tag count. Normalize: `toLowerCase().trim()`, deduplicate. Allow any string.
**Rationale:** Tags like "testing", "frontend", "auth", "code-review", "python", "refactoring" are all reasonable. Let usage patterns emerge. No taxonomy enforcement (locked by REG-03 and out-of-scope decision).
**Examples:** `["code-review", "testing", "typescript"]`, `["architecture", "planning"]`

### Liveness Thresholds: Configurable with Sensible Defaults
**Recommendation:** Default 5 min idle, 30 min gone. Configurable via `config.yml` under a new `agents` section.
**Rationale:** Claude Code sessions typically have tool calls every few seconds to minutes. A 5-minute gap suggests the agent paused. 30 minutes suggests the session ended. Making them configurable lets power users tune for their workflow.
**Gone cleanup:** Keep gone agents in registry indefinitely. They cost nothing (tiny JSON entries) and provide history. Phase 12+ may want to show "previously active agents." Do NOT auto-prune.

```yaml
# config.yml extension
agents:
  liveness:
    idle_after_ms: 300000      # 5 minutes
    gone_after_ms: 1800000     # 30 minutes
```

### Handoff Results: Structured with Status
**Recommendation:** Array of `HandoffResult` objects, each with `description`, `status` ("completed"|"partial"|"blocked"|"failed"), optional `artifacts` and `notes`.
**Rationale:** Structured results allow Phase 13's context assembler to prioritize completed work and flag blocked items. Free-form string would lose this signal.

### Context Snapshot: Decisions + Warnings + Findings
**Recommendation:** Include decision IDs, warning IDs, and finding IDs — plus a short list of human-readable summaries.
**Rationale:** Decisions and warnings are the most important context. Findings provide recent discoveries. Questions and offers are too transient. Storing just IDs keeps the handoff small; the consumer loads full objects via existing tools.

### Handoff Scope Field: Yes
**Recommendation:** Include optional `scope?: string` on handoff records, same semantics as decision/blackboard scope (file path prefix matching).
**Rationale:** Phase 13 needs `twining_assemble` to include relevant handoffs. Scope filtering is how assembly works for every other data type.

### JSONL Index for Handoffs
**Recommendation:** Use JSONL (not JSON array) for the handoff index. Append-only, one entry per line.
**Rationale:** Handoffs are created but rarely updated (only acknowledgment). JSONL is append-friendly and matches the blackboard pattern. For acknowledgment updates, rewrite the index (small, bounded by handoff count).
**Query patterns supported:**
- List all handoffs (read full index)
- Filter by source/target agent (scan index)
- Filter by scope (prefix match on index)
- Filter by time (compare timestamps in index)
- Check acknowledgment status (boolean in index entry)
**Trade-off vs JSON:** Acknowledging a handoff requires rewriting the JSONL index (finding and updating one line). For the expected volume (<100 handoffs), this is fine. Could alternatively use a JSON array like decisions/index.json — either works. JSONL chosen for consistency with the stated success criteria.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| N/A — new domain | File-native JSON/JSONL storage | Phase 11 | First agent coordination data in Twining |

**No deprecated patterns to note** — this is greenfield within an established codebase.

## Open Questions

1. **Config extension for liveness thresholds**
   - What we know: Thresholds should be configurable. Config is loaded from `config.yml` and deep-merged with defaults.
   - What's unclear: Whether to add an `agents` section to `TwiningConfig` interface in Phase 11 or defer to Phase 12 when it's actually consumed.
   - Recommendation: Add the config type and defaults in Phase 11 since the types phase is the right place. The liveness function uses them immediately for computation tests.

2. **Handoff index format: JSONL vs JSON**
   - What we know: Success criteria says "JSONL index." DecisionStore uses JSON (`index.json`). Blackboard uses JSONL.
   - What's unclear: The success criteria explicitly says JSONL, but the acknowledge operation (updating `acknowledged` flag) is easier with JSON array (random access).
   - Recommendation: Use JSONL as stated in success criteria. Acknowledge rewrites the index file. Volume is low enough that rewriting is not a concern.

3. **Agent `last_active` update frequency**
   - What we know: REG-01 says "auto-registers on first Twining tool call." REG-04 says "liveness inferred from last activity."
   - What's unclear: Should every single tool call update `last_active`, or only explicit calls? Updating on every call means high write frequency to registry.json.
   - Recommendation: In Phase 11, just provide the `touch()` method. Phase 12-13 will decide the call-site (likely a middleware wrapper in tool registration). The store just needs to support the operation efficiently.

## Sources

### Primary (HIGH confidence)
- **Existing codebase** (`src/storage/*.ts`, `src/utils/types.ts`, `src/storage/init.ts`) — analyzed all existing storage patterns, type definitions, initialization code, and test conventions
- **TWINING-DESIGN-SPEC.md** — section 2.2 (file structure), section 3 (data models), section 10 (implementation notes)
- **REQUIREMENTS.md** — REG-01 through REG-04, HND-05, out-of-scope decisions
- **ROADMAP.md** — Phase 11-14 success criteria and downstream requirements

### Secondary (MEDIUM confidence)
- **CONTEXT.md** — User decisions and discretion areas from `/gsd:discuss-phase`
- **STATE.md** — Prior decisions about delegations, liveness, and handoff records

### Tertiary (LOW confidence)
- None — all findings derived from existing codebase analysis and project documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, all patterns established in codebase
- Architecture: HIGH — direct pattern replication from existing stores (DecisionStore, GraphStore)
- Pitfalls: HIGH — pitfalls identified from patterns observed in existing code and known file I/O concerns
- Data models: HIGH — designed to serve documented Phase 12-14 query patterns

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (stable — internal patterns, no external dependencies)
