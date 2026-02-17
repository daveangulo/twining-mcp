# Phase 12: Coordination Engine - Research

**Researched:** 2026-02-17
**Domain:** Agent coordination business logic (discovery, delegation matching, handoff creation)
**Confidence:** HIGH

## Summary

Phase 12 builds the engine layer for agent coordination on top of Phase 11's storage layer. The work divides into three distinct domains: (1) agent discovery with scored matching, (2) delegation needs as structured blackboard entries with expiry and matching, and (3) handoff creation with context snapshot assembly. All three compose existing primitives -- AgentStore, HandoffStore, BlackboardEngine, computeLiveness, and normalizeTags -- with new coordination logic in a `CoordinationEngine` class (following the BlackboardEngine/DecisionEngine pattern).

The key design challenge is the delegation matching algorithm. When a delegation need is posted, the system must score all registered agents by capability overlap (how many required tags match) and liveness (active > idle > gone). This produces a ranked list of suggested agents. Delegation needs are blackboard entries with structured metadata (entry_type "need", with delegation-specific fields in `detail` or a typed wrapper), supporting urgency levels and configurable auto-expiry timeouts.

No new libraries are needed. All coordination logic composes existing storage primitives, the blackboard posting mechanism, and the liveness computation. The engine layer produces pure coordination results; MCP tool registration happens in Phase 13.

**Primary recommendation:** Create a `CoordinationEngine` class in `src/engine/coordination.ts` that depends on AgentStore, HandoffStore, BlackboardEngine, and TwiningConfig. Implement `discover()`, `postDelegation()`, and `createHandoff()` methods. Use TDD with the same test patterns established in Phase 11.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DEL-01 | Agent can discover other agents by capability tags via `twining_discover` | CoordinationEngine.discover() queries AgentStore.findByCapabilities(), scores by overlap + liveness, returns ranked list |
| DEL-02 | Agent can post a delegation need with required capabilities to the blackboard | CoordinationEngine.postDelegation() posts a "need" entry with structured delegation metadata (required_capabilities, urgency, expires_at) |
| DEL-03 | System suggests matching agents when a delegation need is posted | postDelegation() calls discover() internally and returns suggested_agents alongside the posted need |
| DEL-06 | Delegation needs support urgency levels (high/normal/low) | DelegationInput includes urgency field; stored in blackboard entry tags or detail metadata |
| DEL-07 | Delegation needs auto-expire after configurable timeout | expires_at timestamp computed from urgency-based defaults or explicit timeout; expiry check on read |
| DEL-08 | Agents scored by capability overlap + liveness when matching delegations | Scoring formula: (matched_tags / required_tags) * capability_weight + liveness_score * liveness_weight |
| HND-01 | Agent can create a structured handoff record with results and context | CoordinationEngine.createHandoff() delegates to HandoffStore.create() with validated input |
| HND-02 | Handoff records include context snapshot (referenced decision/warning IDs and summaries) | createHandoff() assembles context snapshot from DecisionStore and BlackboardStore, collecting relevant IDs and summaries |
| HND-04 | Handoff consumer can acknowledge receipt (acceptance tracking) | CoordinationEngine.acknowledgeHandoff() delegates to HandoffStore.acknowledge() |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| proper-lockfile | ^4.1.2 | Advisory file locking (via file-store.ts) | Already used by all stores |
| ulid | ^3.0.2 | ID generation (via ids.ts) | Project convention |
| vitest | ^4.0.18 | Test framework | Already configured |
| zod | ^3.x | Schema validation for tool inputs | Already used by all tool registrations |

### Supporting
No new libraries needed. This phase composes existing infrastructure:
- `AgentStore` (Phase 11) for agent registry queries
- `HandoffStore` (Phase 11) for handoff persistence
- `BlackboardEngine` (Phase 1) for posting delegation needs
- `DecisionStore` (Phase 1) for context snapshot assembly
- `computeLiveness` (Phase 11) for agent liveness scoring
- `normalizeTags` (Phase 11) for capability tag normalization

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Engine-layer coordination class | Direct logic in tool handlers | Engine layer allows unit testing without MCP server setup; follows established pattern (BlackboardEngine, DecisionEngine) |
| Delegation as "need" blackboard entry | New entry_type "delegation" | Using existing "need" type avoids changing the EntryType union; delegation metadata lives in structured detail field |
| Inline context snapshot assembly | Delegating to ContextAssembler | Inline is simpler -- only need decision IDs, warning IDs, and summaries, not the full token-budgeted assembly |

**Installation:**
No new packages needed.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── engine/
│   └── coordination.ts       # NEW: CoordinationEngine (discover, delegate, handoff)
├── storage/
│   ├── agent-store.ts         # EXISTS: AgentStore (Phase 11)
│   └── handoff-store.ts       # EXISTS: HandoffStore (Phase 11)
├── utils/
│   ├── types.ts               # EXTEND: DelegationMetadata, DiscoverResult, HandoffInput types
│   ├── liveness.ts            # EXISTS: computeLiveness (Phase 11)
│   └── tags.ts                # EXISTS: normalizeTags (Phase 11)
test/
└── coordination-engine.test.ts  # NEW: Comprehensive tests for coordination logic
```

### Pattern 1: CoordinationEngine (follows DecisionEngine pattern)

**What:** A business logic class that orchestrates agent coordination operations, composing storage and engine dependencies.
**When to use:** When operations span multiple stores (agent registry + blackboard + handoff) and include non-trivial logic (scoring, expiry, context assembly).
**Why this pattern:** Identical to how `DecisionEngine` composes `DecisionStore` + `BlackboardEngine` + `Embedder`. Enables isolated unit testing with injected dependencies.

```typescript
// Source: follows existing engine pattern (decisions.ts, blackboard.ts)
export class CoordinationEngine {
  private readonly agentStore: AgentStore;
  private readonly handoffStore: HandoffStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly decisionStore: DecisionStore;
  private readonly blackboardStore: BlackboardStore;
  private readonly config: TwiningConfig;

  constructor(
    agentStore: AgentStore,
    handoffStore: HandoffStore,
    blackboardEngine: BlackboardEngine,
    decisionStore: DecisionStore,
    blackboardStore: BlackboardStore,
    config: TwiningConfig,
  ) {
    this.agentStore = agentStore;
    this.handoffStore = handoffStore;
    this.blackboardEngine = blackboardEngine;
    this.decisionStore = decisionStore;
    this.blackboardStore = blackboardStore;
    this.config = config;
  }

  /** Discover agents matching required capabilities, scored and ranked. */
  async discover(input: DiscoverInput): Promise<DiscoverResult> { /* ... */ }

  /** Post a delegation need to the blackboard with agent suggestions. */
  async postDelegation(input: DelegationInput): Promise<DelegationResult> { /* ... */ }

  /** Create a handoff record with context snapshot. */
  async createHandoff(input: CreateHandoffInput): Promise<HandoffRecord> { /* ... */ }

  /** Acknowledge a handoff. */
  async acknowledgeHandoff(id: string, acknowledgedBy: string): Promise<HandoffRecord> { /* ... */ }
}
```

### Pattern 2: Discovery Scoring Algorithm

**What:** A pure scoring function that ranks agents by capability overlap and liveness.
**When to use:** Called by both `discover()` (standalone) and `postDelegation()` (as side-effect).
**Why this pattern:** Separating scoring into a pure function enables direct unit testing of the algorithm without store setup.

```typescript
// Scoring formula
export interface AgentScore {
  agent: AgentRecord;
  liveness: AgentLiveness;
  capability_overlap: number;   // matched_count / required_count (0-1)
  liveness_score: number;       // active=1.0, idle=0.5, gone=0.1
  total_score: number;          // weighted combination
  matched_capabilities: string[]; // which tags matched
}

export function scoreAgent(
  agent: AgentRecord,
  requiredCapabilities: string[],
  livenessThresholds: LivenessThresholds,
  now: Date = new Date(),
): AgentScore {
  const normalizedRequired = normalizeTags(requiredCapabilities);
  const matched = agent.capabilities.filter(cap =>
    normalizedRequired.includes(cap)
  );
  const capabilityOverlap = normalizedRequired.length > 0
    ? matched.length / normalizedRequired.length
    : 0;

  const liveness = computeLiveness(agent.last_active, now, livenessThresholds);
  const livenessScore =
    liveness === "active" ? 1.0 :
    liveness === "idle" ? 0.5 :
    0.1;

  // Capability overlap weighted 70%, liveness weighted 30%
  const totalScore = capabilityOverlap * 0.7 + livenessScore * 0.3;

  return {
    agent,
    liveness,
    capability_overlap: capabilityOverlap,
    liveness_score: livenessScore,
    total_score: totalScore,
    matched_capabilities: matched,
  };
}
```

### Pattern 3: Delegation as Structured Blackboard Entry

**What:** Delegation needs are posted as blackboard entries with `entry_type: "need"` and structured metadata in the `detail` field (JSON-encoded DelegationMetadata).
**When to use:** When posting a delegation need (DEL-02).
**Why this pattern:** Prior decision locks delegations as blackboard entries with structured metadata. Using existing "need" type avoids modifying the EntryType union. The detail field holds JSON metadata that can be parsed when reading delegation needs.

```typescript
export interface DelegationMetadata {
  type: "delegation";                    // Discriminator for parsing
  required_capabilities: string[];       // Tags to match
  urgency: "high" | "normal" | "low";   // DEL-06
  expires_at: string;                    // ISO 8601 (DEL-07)
  suggested_agents?: AgentScore[];       // Populated by postDelegation (DEL-03)
}

// Urgency-based default timeouts
export const DELEGATION_TIMEOUTS: Record<string, number> = {
  high: 5 * 60 * 1000,     // 5 minutes
  normal: 30 * 60 * 1000,  // 30 minutes
  low: 4 * 60 * 60 * 1000, // 4 hours
};
```

### Pattern 4: Context Snapshot Assembly for Handoffs

**What:** When creating a handoff, collect relevant decision IDs, warning IDs, finding IDs, and summaries from the current scope.
**When to use:** When creating a handoff record (HND-01, HND-02).
**Why this pattern:** Handoffs store IDs and summaries (prior decision), not full context serialization. The consumer can hydrate full objects via `twining_assemble` or `twining_why`.

```typescript
async assembleContextSnapshot(
  scope?: string,
): Promise<HandoffRecord["context_snapshot"]> {
  // Get relevant decision IDs
  const decisionIndex = await this.decisionStore.getIndex();
  const scopeDecisions = scope
    ? decisionIndex.filter(d =>
        d.status === "active" &&
        (d.scope.startsWith(scope) || scope.startsWith(d.scope))
      )
    : decisionIndex.filter(d => d.status === "active");

  // Get relevant warnings and findings from blackboard
  const { entries } = await this.blackboardStore.read({
    scope,
    entry_types: ["warning", "finding"],
  });

  const warningEntries = entries.filter(e => e.entry_type === "warning");
  const findingEntries = entries.filter(e => e.entry_type === "finding");

  return {
    decision_ids: scopeDecisions.map(d => d.id),
    warning_ids: warningEntries.map(e => e.id),
    finding_ids: findingEntries.map(e => e.id),
    summaries: [
      ...scopeDecisions.slice(0, 5).map(d => `Decision: ${d.summary}`),
      ...warningEntries.slice(0, 3).map(e => `Warning: ${e.summary}`),
      ...findingEntries.slice(0, 3).map(e => `Finding: ${e.summary}`),
    ],
  };
}
```

### Anti-Patterns to Avoid
- **New entry_type for delegations:** Do NOT add "delegation" to the EntryType union. Prior decision locks delegations as blackboard "need" entries with structured metadata. Adding a new type would require changes across 10+ existing tool/engine files.
- **Separate delegation queue/store:** Prior decision explicitly excludes this. Delegations live on the blackboard.
- **Scoring that ignores gone agents:** Include gone agents with low score (0.1) rather than filtering them out entirely. They exist in the registry and may come back online.
- **Full context in handoffs:** Do NOT serialize full decision/warning objects into the handoff record. Store IDs and short summaries only (prior decision).
- **Tool registration in this phase:** Phase 12 is the engine layer only. MCP tool registration (`twining_discover`, `twining_register`, `twining_handoff`, `twining_acknowledge`) happens in Phase 13 (Tools and Assembly). Keep engine logic separate from tool wiring.

**Important clarification on Phase 12 vs Phase 13 boundary:** The ROADMAP success criteria for Phase 12 describe observable behaviors ("An agent can discover..."), but the tool surface is Phase 13's responsibility. Phase 12 implements the CoordinationEngine methods that Phase 13's tools will call. This matches the existing pattern: Phase 1 built BlackboardEngine, then tool registration wired to it.

However, to satisfy Phase 12's success criteria in a testable way, the engine methods must be directly testable (unit tests call engine methods, not MCP tools). This is exactly how existing phases work -- `decision-engine.test.ts` tests `DecisionEngine.decide()` directly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File locking | Custom locks | `file-store.ts` readJSON/writeJSON/appendJSONL | Already handles all locking, directory creation, error recovery |
| Tag normalization | Manual lowercase/trim | `normalizeTags()` from tags.ts | Already handles lowercase, trim, dedup, empty filtering |
| Liveness computation | Threshold logic | `computeLiveness()` from liveness.ts | Already handles active/idle/gone with configurable thresholds |
| Handoff persistence | Custom file writes | `HandoffStore.create()` from Phase 11 | Already handles JSON file + JSONL index + ID generation |
| Blackboard posting | Direct JSONL append | `BlackboardEngine.post()` | Already handles validation, embedding generation, defaults |
| Agent querying | Custom registry reads | `AgentStore.findByCapabilities()` | Already handles normalization and OR matching |

**Key insight:** Phase 12's CoordinationEngine is a thin orchestration layer. The heavy lifting (file I/O, locking, validation, embedding) is already done. The new value is the coordination algorithms: scoring, matching, expiry, and context snapshot assembly.

## Common Pitfalls

### Pitfall 1: Delegation Metadata Serialization/Deserialization
**What goes wrong:** Storing structured DelegationMetadata in the blackboard `detail` field as JSON, but forgetting that `detail` is a plain string field. Consumers must parse it, and invalid JSON crashes reads.
**Why it happens:** The blackboard `detail` field is `string`, not `object`. Delegation metadata needs to be JSON-stringified on write and parsed on read.
**How to avoid:** Always wrap delegation metadata serialization in try/catch. Provide a `parseDelegationMetadata(entry: BlackboardEntry): DelegationMetadata | null` helper that returns null on parse failure. Test with invalid/malformed detail strings.
**Warning signs:** Tests that always use well-formed delegation entries without testing malformed ones.

### Pitfall 2: Expiry Checking at Read Time vs Write Time
**What goes wrong:** Computing `expires_at` at write time but never checking it on read. Expired delegation needs remain visible indefinitely.
**Why it happens:** The blackboard doesn't have built-in expiry. Must add expiry filtering in the coordination layer.
**How to avoid:** The `discover()` path doesn't need expiry. But any method that lists delegation needs (Phase 13's tool) should filter out expired entries. In Phase 12, add an `isExpired(metadata: DelegationMetadata): boolean` helper and test it. The actual filtering happens where delegation needs are listed.
**Warning signs:** Tests that create delegation needs but never advance time past expiry.

### Pitfall 3: Score Normalization with Zero Required Capabilities
**What goes wrong:** Division by zero when `required_capabilities` is empty. `matched / 0 = NaN`, which propagates through sorting.
**Why it happens:** Edge case -- discovering agents without specifying required capabilities.
**How to avoid:** Guard: `if (normalizedRequired.length === 0) return 0` for capability_overlap. Still rank by liveness alone when no capabilities specified. Test this edge case explicitly.
**Warning signs:** Tests that always provide at least one required capability.

### Pitfall 4: Context Snapshot Assembly Scope Mismatch
**What goes wrong:** Handoff created with `scope: "src/auth/"` but context snapshot finds no decisions because decisions use scope `"src/auth/jwt.ts"` (more specific) or `"src/"` (less specific).
**Why it happens:** Scope matching in Twining uses prefix semantics bidirectionally. Need to match both ways: `entry.scope.startsWith(scope) || scope.startsWith(entry.scope)`.
**How to avoid:** Use the same bidirectional scope matching already in BlackboardStore.read() and DecisionStore.getByScope(). Don't invent a different matching rule.
**Warning signs:** Tests that use exact scope matches only.

### Pitfall 5: Circular Dependency Between Engine Modules
**What goes wrong:** CoordinationEngine depends on BlackboardEngine for posting, and BlackboardEngine depends on CoordinationEngine for... nothing. But if someone adds auto-delegation-matching on every blackboard post, it creates a cycle.
**Why it happens:** The blackboard is the delegation medium AND the coordination layer posts to it.
**How to avoid:** CoordinationEngine depends on BlackboardEngine (one-way). Never make BlackboardEngine depend on CoordinationEngine. Delegation matching is triggered by explicit `postDelegation()` calls, not by every blackboard post.
**Warning signs:** Imports from coordination.ts appearing in blackboard.ts.

## Code Examples

### Type Definitions (to add to types.ts)

```typescript
// Agent discovery result types
export interface DiscoverInput {
  required_capabilities: string[];
  include_gone?: boolean;       // Include gone agents (default: true)
  min_score?: number;           // Minimum total_score threshold (default: 0)
}

export interface AgentScore {
  agent_id: string;
  capabilities: string[];
  role?: string;
  description?: string;
  liveness: AgentLiveness;
  capability_overlap: number;   // 0-1: matched/required
  liveness_score: number;       // active=1.0, idle=0.5, gone=0.1
  total_score: number;          // weighted combination
  matched_capabilities: string[];
}

export interface DiscoverResult {
  agents: AgentScore[];
  total_registered: number;
}

// Delegation types
export type DelegationUrgency = "high" | "normal" | "low";

export interface DelegationMetadata {
  type: "delegation";
  required_capabilities: string[];
  urgency: DelegationUrgency;
  expires_at: string;
  timeout_ms?: number;          // Original timeout value
}

export interface DelegationInput {
  summary: string;
  required_capabilities: string[];
  urgency?: DelegationUrgency;  // Default: "normal"
  timeout_ms?: number;          // Override default expiry
  scope?: string;
  tags?: string[];
  agent_id?: string;
}

export interface DelegationResult {
  entry_id: string;             // Blackboard entry ID
  timestamp: string;
  expires_at: string;
  suggested_agents: AgentScore[];
}

// Handoff creation input
export interface CreateHandoffInput {
  source_agent: string;
  target_agent?: string;
  scope?: string;
  summary: string;
  results: HandoffResult[];
  auto_snapshot?: boolean;      // Auto-assemble context snapshot (default: true)
  context_snapshot?: HandoffRecord["context_snapshot"]; // Manual override
}
```

### Discovery Method

```typescript
async discover(input: DiscoverInput): Promise<DiscoverResult> {
  const agents = await this.agentStore.getAll();
  const thresholds = this.config.agents?.liveness ?? DEFAULT_LIVENESS_THRESHOLDS;
  const now = new Date();

  const scores: AgentScore[] = agents
    .map(agent => scoreAgent(agent, input.required_capabilities, thresholds, now))
    .filter(score => {
      if (!input.include_gone && score.liveness === "gone") return false;
      if (input.min_score !== undefined && score.total_score < input.min_score) return false;
      return true;
    })
    .sort((a, b) => b.total_score - a.total_score);

  return {
    agents: scores,
    total_registered: agents.length,
  };
}
```

### Post Delegation Method

```typescript
async postDelegation(input: DelegationInput): Promise<DelegationResult> {
  const urgency = input.urgency ?? "normal";
  const timeoutMs = input.timeout_ms ?? DELEGATION_TIMEOUTS[urgency]!;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + timeoutMs).toISOString();

  const metadata: DelegationMetadata = {
    type: "delegation",
    required_capabilities: normalizeTags(input.required_capabilities),
    urgency,
    expires_at: expiresAt,
    timeout_ms: timeoutMs,
  };

  // Post to blackboard as a "need" entry
  const { id, timestamp } = await this.blackboardEngine.post({
    entry_type: "need",
    summary: input.summary,
    detail: JSON.stringify(metadata),
    tags: [...(input.tags ?? []), "delegation", urgency],
    scope: input.scope ?? "project",
    agent_id: input.agent_id ?? "main",
  });

  // Discover matching agents
  const { agents: suggestedAgents } = await this.discover({
    required_capabilities: input.required_capabilities,
    include_gone: false,
  });

  return {
    entry_id: id,
    timestamp,
    expires_at: expiresAt,
    suggested_agents: suggestedAgents,
  };
}
```

### Create Handoff Method

```typescript
async createHandoff(input: CreateHandoffInput): Promise<HandoffRecord> {
  // Auto-assemble context snapshot if not provided
  let contextSnapshot = input.context_snapshot;
  if (!contextSnapshot && (input.auto_snapshot !== false)) {
    contextSnapshot = await this.assembleContextSnapshot(input.scope);
  }

  const record = await this.handoffStore.create({
    source_agent: input.source_agent,
    target_agent: input.target_agent,
    scope: input.scope,
    summary: input.summary,
    results: input.results,
    context_snapshot: contextSnapshot ?? {
      decision_ids: [],
      warning_ids: [],
      finding_ids: [],
      summaries: [],
    },
  });

  // Post status entry to blackboard for visibility
  await this.blackboardEngine.post({
    entry_type: "status",
    summary: `Handoff created: ${input.summary}`.slice(0, 200),
    detail: `From ${input.source_agent} to ${input.target_agent ?? "any agent"}. ${input.results.length} result(s).`,
    tags: ["handoff"],
    scope: input.scope ?? "project",
    agent_id: input.source_agent,
  });

  return record;
}
```

### Delegation Expiry Helper

```typescript
export function isDelegationExpired(
  metadata: DelegationMetadata,
  now: Date = new Date(),
): boolean {
  return now.getTime() > new Date(metadata.expires_at).getTime();
}

export function parseDelegationMetadata(
  entry: BlackboardEntry,
): DelegationMetadata | null {
  try {
    const parsed = JSON.parse(entry.detail);
    if (parsed && parsed.type === "delegation") {
      return parsed as DelegationMetadata;
    }
    return null;
  } catch {
    return null;
  }
}
```

### Test Pattern

```typescript
// Source: follows test/agent-store.test.ts and test/decision-engine.test.ts patterns
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CoordinationEngine } from "../src/engine/coordination.js";
import { AgentStore } from "../src/storage/agent-store.js";
import { HandoffStore } from "../src/storage/handoff-store.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let tmpDir: string;
let engine: CoordinationEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-coord-test-"));
  // Create all required directories and files
  fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "agents", "registry.json"), "[]");
  fs.writeFileSync(path.join(tmpDir, "decisions", "index.json"), "[]");
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");

  const agentStore = new AgentStore(tmpDir);
  const handoffStore = new HandoffStore(tmpDir);
  const blackboardStore = new BlackboardStore(tmpDir);
  const blackboardEngine = new BlackboardEngine(blackboardStore);
  const decisionStore = new DecisionStore(tmpDir);

  engine = new CoordinationEngine(
    agentStore, handoffStore, blackboardEngine, decisionStore, blackboardStore, DEFAULT_CONFIG,
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| N/A -- new domain | Engine-layer coordination composing Phase 11 stores | Phase 12 | First coordination logic in Twining |
| Separate delegation queue | Delegations as blackboard "need" entries | Prior decision | Keeps data unified; blackboard is the single source of shared state |
| Heartbeat protocol | Liveness inferred from last_active timestamp | Prior decision | No extra infrastructure; no wasted tokens |

**No deprecated patterns to note** -- this is greenfield engine logic built on established Phase 1-11 infrastructure.

## Design Decisions Summary

### Scoring Weight Distribution: 70% Capability / 30% Liveness
**Rationale:** Capability match is the primary signal -- an agent that can do the work matters more than one that is merely online. But an active agent with 80% capability match should rank above a gone agent with 100% match. The 70/30 split ensures this.
**Alternative considered:** 50/50 split -- rejected because it would rank an active agent with 1/3 capability overlap above a gone agent with full capability match, which is wrong.
**Confidence:** MEDIUM -- weights are tunable; these are reasonable defaults.

### Delegation Metadata in `detail` Field (JSON-stringified)
**Rationale:** The blackboard entry `detail` field is already a string. Putting JSON-encoded metadata there avoids changing the BlackboardEntry schema or adding a new entry type. The "need" entry_type already semantically matches "I need someone to do X."
**Trade-off:** Consumers must parse JSON from detail. Mitigated by `parseDelegationMetadata()` helper with graceful null return.
**Confidence:** HIGH -- locked by prior decision that delegations are blackboard entries with structured metadata.

### Urgency-Based Default Timeouts
**Rationale:** Different urgency levels should expire at different rates. High urgency needs expire in 5 minutes (if nobody picks it up quickly, escalate). Normal in 30 minutes. Low in 4 hours.
**Confidence:** MEDIUM -- timeout values are reasonable defaults but may need tuning based on real usage patterns. They should be configurable (either in config.yml or overridable per-call via `timeout_ms`).

### Auto Context Snapshot in Handoff Creation
**Rationale:** Most handoff creators want the current context snapshot without having to manually assemble IDs. Auto-snapshot reads active decisions and warnings for the scope and includes their IDs and summaries. Can be disabled with `auto_snapshot: false` or overridden with an explicit `context_snapshot`.
**Confidence:** HIGH -- reduces friction for the common case while preserving flexibility.

## Open Questions

1. **Delegation expiry: filter on read or garbage-collect?**
   - What we know: DEL-07 requires auto-expiry after configurable timeout. The `expires_at` field is set on write.
   - What's unclear: Should expired delegation needs be filtered from blackboard reads in the coordination layer? Or should they be physically removed/archived? Blackboard entries are append-only.
   - Recommendation: Filter on read in the coordination layer. Expired entries remain in the blackboard (append-only semantics) but are excluded when listing active delegation needs. The dashboard (Phase 14) can show them as "expired" rather than hiding them. This avoids mutating the blackboard and keeps the simple append-only model.

2. **Config extension for delegation timeouts**
   - What we know: Urgency-based timeouts should be configurable (DEL-07 says "configurable timeout").
   - What's unclear: Whether to add a `delegations` section to config.yml or just support per-call `timeout_ms` overrides.
   - Recommendation: Add a `delegations` section to config.yml with default timeouts per urgency level. Also support per-call `timeout_ms` override. Config provides project-level defaults; per-call provides flexibility.

3. **Phase 12 vs Phase 13 tool boundary for `twining_register`**
   - What we know: Phase 12 success criteria say "An agent can discover..." and Phase 13 says "twining_agents lists all registered agents." The `twining_register` tool was mentioned in REG-02 but isn't explicitly in either phase's requirement list.
   - What's unclear: Should Phase 12 include `twining_register` engine logic, or does it already exist via AgentStore.upsert?
   - Recommendation: AgentStore.upsert() already IS the register operation. CoordinationEngine does not need a separate `register()` method -- it delegates to AgentStore directly. The `twining_register` MCP tool (Phase 13) will call agentStore.upsert(). Phase 12's discover/delegate/handoff methods can call agentStore.touch() to auto-register on use.

## Sources

### Primary (HIGH confidence)
- **Existing codebase** (`src/engine/decisions.ts`, `src/engine/blackboard.ts`, `src/storage/agent-store.ts`, `src/storage/handoff-store.ts`, `src/utils/types.ts`, `src/utils/liveness.ts`, `src/utils/tags.ts`) -- analyzed all patterns, interfaces, and conventions
- **TWINING-DESIGN-SPEC.md** -- section 12 (Future Phases), section 2.1 (architecture), section 3 (data models)
- **ROADMAP.md** -- Phase 12 success criteria and downstream Phase 13/14 needs
- **REQUIREMENTS.md** -- DEL-01 through DEL-08, HND-01/02/04 requirement text
- **Phase 11 plans and verification** -- 11-CONTEXT.md, 11-RESEARCH.md, 11-VERIFICATION.md for established patterns and prior decisions

### Secondary (MEDIUM confidence)
- **STATE.md** -- Prior decisions about delegations, liveness, handoff records, tag normalization, upsert semantics

### Tertiary (LOW confidence)
- None -- all findings derived from codebase analysis and project documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries, all patterns established in codebase
- Architecture: HIGH -- direct pattern replication from existing engines (DecisionEngine, BlackboardEngine)
- Scoring algorithm: MEDIUM -- weights (70/30) are reasonable defaults but may need tuning
- Pitfalls: HIGH -- identified from existing codebase patterns and known serialization/scope-matching concerns
- Delegation timeouts: MEDIUM -- default values are reasonable but may need tuning

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (stable -- internal patterns, no external dependencies)
