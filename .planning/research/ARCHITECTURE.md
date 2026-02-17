# Architecture: Agent Coordination Integration

**Domain:** Agent Registry, Capability Matching, Delegation, and Handoffs for Twining MCP Server
**Researched:** 2026-02-17
**Confidence:** HIGH (architecture derives from existing patterns and codebase analysis)

## Executive Summary

Agent coordination integrates into Twining's existing architecture as a new horizontal layer that sits beside (not above) the existing blackboard, decisions, and graph systems. The key insight is that Twining already has 80% of the coordination infrastructure: the blackboard's "need"/"offer" entry types are the delegation mechanism, the context assembler is the handoff packager, and the knowledge graph can store agent-capability relationships. What's missing is the agent registry (who exists and what they can do), capability-typed needs (structured delegation requests), structured handoff records (context packages with completion status), and need/offer matching logic.

The architecture adds 3 new storage files, 2 new engine modules, 1 new tool file, and modifications to 4 existing modules. No existing APIs change -- all new features are additive.

## Recommended Architecture

### System Overview

```
+--------------------------------------------------------------------+
|                    Twining MCP Server Process                       |
+--------------------------------------------------------------------+
|                                                                     |
|  +------------------+  +------------------+  +------------------+  |
|  |   Blackboard     |  |   Decision       |  |   Context        |  |
|  |   Engine         |  |   Tracker        |  |   Assembler      |  |
|  +--------+---------+  +--------+---------+  +--------+---------+  |
|           |                      |                      |           |
|  +--------+----------------------+----------------------+---------+ |
|  |                  Agent Coordination Layer (NEW)                 | |
|  |  +----------------+  +------------------+  +----------------+  | |
|  |  | Agent Registry |  | Delegation       |  | Handoff        |  | |
|  |  | Engine         |  | Matcher          |  | Manager        |  | |
|  |  +------+---------+  +--------+---------+  +------+---------+  | |
|  +---------|----------------------|----------------------|---------+ |
|            |                      |                      |           |
|  +---------+----------------------+----------------------+---------+ |
|  |                    Knowledge Graph                              | |
|  +-----------------------------+-----------------------------------+ |
|                                |                                     |
|  +-----------------------------+-----------------------------------+ |
|  |              File Storage Layer (.twining/)                     | |
|  +------------------------------------------------------------------+
|                                                                     |
+---------------------------+-----------------------------------------+
|                  MCP Tool Surface                                   |
|                                                                     |
|  Existing:                                                          |
|    Blackboard: post, read, query, recent                            |
|    Decisions:  decide, why, trace, reconsider, override, search     |
|    Context:    assemble, summarize, what_changed                    |
|    Graph:      add_entity, add_relation, neighbors, graph_query     |
|    Lifecycle:  archive, status                                      |
|    Export:     export                                                |
|                                                                     |
|  NEW (v1.3):                                                        |
|    Agents:     register, discover, delegate, handoff, agents        |
|                                                                     |
+--------------------------------------------------------------------+
```

### Component Boundaries

| Component | Responsibility | Communicates With | New/Modified |
|-----------|---------------|-------------------|-------------|
| `AgentStore` | CRUD for agent registry, liveness tracking | File store, AgentEngine | NEW |
| `HandoffStore` | CRUD for handoff records | File store, HandoffManager | NEW |
| `AgentEngine` | Registration, discovery, capability matching | AgentStore, GraphEngine | NEW |
| `DelegationMatcher` | Match blackboard needs to agent capabilities | BlackboardStore, AgentStore | NEW (inside AgentEngine) |
| `HandoffManager` | Create/complete handoffs, package context | HandoffStore, ContextAssembler, BlackboardEngine | NEW (inside AgentEngine) |
| `BlackboardEngine` | Post entries (extended with delegation metadata) | BlackboardStore (unchanged interface) | MODIFIED (minor) |
| `ContextAssembler` | Assemble context (extended with handoff awareness) | BlackboardStore, DecisionStore, HandoffStore | MODIFIED (minor) |
| `GraphEngine` | Entity/relation CRUD (gains "agent" entity type) | GraphStore (unchanged interface) | UNCHANGED (type extension in types.ts) |
| `lifecycle-tools.ts` | Status tool (extended with agent counts) | AgentStore | MODIFIED (minor) |
| `server.ts` | Wire up new stores/engines, register new tools | All stores and engines | MODIFIED |

### Data Flow

#### Agent Registration Flow
```
Agent calls twining_register
  -> AgentEngine.register(name, capabilities, scope?)
    -> AgentStore.upsert(agentRecord)
    -> GraphEngine.addEntity(name, type="agent", properties={capabilities, scope})
    -> BlackboardEngine.post(entry_type="status", "Agent X registered with capabilities [...]")
    -> return { agent_id, registered_at }
```

#### Delegation Flow (Need -> Match -> Handoff)
```
Agent A calls twining_delegate(need, required_capabilities)
  -> AgentEngine.delegate(need, capabilities)
    -> BlackboardEngine.post(entry_type="need", summary=need,
         detail includes structured capability_requirements)
    -> DelegationMatcher.findMatchingAgents(capabilities)
      -> AgentStore.getByCapabilities(capabilities)
      -> Filter by liveness (last_active within threshold)
      -> Score by capability overlap + scope proximity
    -> return { need_id, matching_agents[], suggestion }
```

#### Handoff Flow
```
Agent B calls twining_handoff(need_id, result_summary, artifacts?)
  -> HandoffManager.createHandoff(need_id, agentId, result, artifacts)
    -> ContextAssembler.assembleForHandoff(need_scope)
      -> Returns relevant decisions, warnings, findings for the scope
    -> HandoffStore.create({ need_id, from_agent, context_snapshot, result, artifacts })
    -> BlackboardEngine.post(entry_type="offer", summary="Handoff for: [need]",
         detail=result_summary, relates_to=[need_id])
    -> AgentStore.updateActivity(agentId)
    -> return { handoff_id, context_snapshot }
```

#### Handoff Consumption Flow
```
Agent A calls twining_assemble(task, scope)
  -> ContextAssembler.assemble(task, scope)  [EXISTING]
    -> [existing logic: decisions, warnings, needs, findings, graph]
    -> NEW: HandoffStore.getRelevantHandoffs(scope)
    -> Include handoff results + context snapshots in assembled output
    -> return AssembledContext (with new handoff_results field)
```

## New File Structure

```
.twining/
  agents/
    registry.json              # Agent registry (array of AgentRecord)
  handoffs/
    index.json                 # Handoff index (summaries for fast lookup)
    {ulid}.json                # Individual handoff records
```

## New Data Models

### AgentRecord

```typescript
interface AgentRecord {
  id: string;                    // ULID
  name: string;                  // Human-readable (e.g., "frontend-specialist")
  agent_id: string;              // Agent identifier (from MCP calls)
  capabilities: string[];        // What this agent can do (tags)
  scope?: string;                // Optional scope restriction
  registered_at: string;         // ISO 8601
  last_active: string;           // ISO 8601, updated on any tool call
  status: "active" | "idle" | "gone";  // Inferred from last_active
  metadata?: Record<string, string>;   // Optional extra info
}
```

**Design rationale:**
- `capabilities` are free-form string tags (not an enum) because agents should self-describe their capabilities at registration time. Examples: `["typescript", "testing", "frontend", "auth"]`. This matches how blackboard tags already work.
- `status` is inferred, not declared. "active" = last_active within 5 minutes, "idle" = within 1 hour, "gone" = older. Agents don't need to send heartbeats.
- Upsert by `name` -- re-registering with the same name updates the record. This handles session restarts cleanly.

### DelegationNeed (extends BlackboardEntry)

Delegation needs are regular blackboard entries with structured metadata in the `detail` field. No new data model needed -- the blackboard already has `entry_type: "need"` and structured `detail`. The delegation metadata is encoded as a JSON block within the detail:

```typescript
// Posted as a regular blackboard entry with structured detail
interface DelegationMetadata {
  type: "delegation";
  required_capabilities: string[];   // Must-have capabilities
  preferred_capabilities?: string[]; // Nice-to-have capabilities
  urgency: "high" | "normal" | "low";
  timeout_hours?: number;            // Auto-expire after N hours
  delegation_id: string;             // Cross-reference ID
}
```

**Design rationale:** Embedding delegation metadata in a regular blackboard entry means existing tools (read, query, recent) already surface delegations. No parallel data structure needed. Agents without v1.3 tools can still see delegations as regular "need" entries. The detail field uses a `<!-- delegation:json -->` marker that the DelegationMatcher recognizes and parses.

### HandoffRecord

```typescript
interface HandoffRecord {
  id: string;                        // ULID
  need_id: string;                   // Blackboard entry this fulfills
  delegation_id?: string;            // Cross-ref to delegation metadata
  from_agent: string;                // Agent providing the result
  to_agent?: string;                 // Agent consuming (if known)

  // What was accomplished
  summary: string;                   // One-line result summary
  result: string;                    // Detailed result/findings
  artifacts: string[];               // File paths, entry IDs, etc.

  // Context snapshot at handoff time
  context_snapshot: {
    relevant_decisions: string[];    // Decision IDs active at handoff
    active_warnings: string[];       // Warning entry IDs
    scope: string;                   // Scope of work
  };

  // Lifecycle
  status: "pending" | "accepted" | "rejected";
  created_at: string;                // ISO 8601
  accepted_at?: string;              // When consumer acknowledged
  rejection_reason?: string;
}
```

**Design rationale:**
- Handoffs are first-class records (not just blackboard entries) because they carry structured context snapshots that need to survive archiving. Blackboard entries get archived; handoff records persist like decisions.
- `context_snapshot` captures the decision/warning state at handoff time, preventing the "stale context" problem where the consuming agent sees different state than what the producing agent saw.
- `status` tracks whether the handoff was consumed, enabling the dashboard to show pending vs completed handoffs.

### HandoffIndexEntry

```typescript
interface HandoffIndexEntry {
  id: string;
  need_id: string;
  delegation_id?: string;
  from_agent: string;
  to_agent?: string;
  summary: string;
  scope: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}
```

## New Source Code Structure

```
src/
  storage/
    agent-store.ts               # NEW: Agent registry CRUD
    handoff-store.ts             # NEW: Handoff record CRUD + index
  engine/
    agent-engine.ts              # NEW: Registration, discovery, delegation, handoff
  tools/
    agent-tools.ts               # NEW: MCP tool handlers for agent coordination
```

## New MCP Tools

### `twining_register`
Register an agent with capabilities.

```typescript
{
  name: string;              // Human-readable agent name
  capabilities: string[];    // What this agent can do
  scope?: string;            // Optional scope restriction
  agent_id?: string;         // Defaults to caller identifier
  metadata?: Record<string, string>;
}
// Returns: { agent_id: string, registered_at: string }
```

### `twining_discover`
Find agents matching capability requirements.

```typescript
{
  capabilities?: string[];    // Required capabilities (AND match)
  scope?: string;             // Scope filter
  include_idle?: boolean;     // Include idle agents (default: false)
}
// Returns: { agents: AgentRecord[], total: number }
```

### `twining_delegate`
Post a delegation need with capability requirements. Returns matching agents.

```typescript
{
  need: string;               // What needs to be done (max 200 chars)
  detail?: string;            // Full context
  required_capabilities: string[];
  preferred_capabilities?: string[];
  scope?: string;
  urgency?: "high" | "normal" | "low";
  timeout_hours?: number;
  agent_id?: string;
}
// Returns: { need_id: string, delegation_id: string, matching_agents: AgentRecord[] }
```

### `twining_handoff`
Complete a delegation with results and context snapshot.

```typescript
{
  need_id: string;            // Blackboard need entry being fulfilled
  summary: string;            // One-line result
  result: string;             // Detailed findings/result
  artifacts?: string[];       // File paths, entry IDs produced
  agent_id?: string;
}
// Returns: { handoff_id: string, context_snapshot: object }
```

### `twining_agents`
List all registered agents with status.

```typescript
{
  status_filter?: "active" | "idle" | "gone" | "all";
}
// Returns: { agents: AgentRecord[], active: number, idle: number, gone: number }
```

## Integration Points with Existing Modules

### 1. types.ts -- Extended Types

Add new types and extend existing ones:

```typescript
// New entity type for knowledge graph
type EntityType = "module" | "function" | "class" | "file" | "concept"
  | "pattern" | "dependency" | "api_endpoint" | "agent";  // NEW

// New relation type
type RelationType = "depends_on" | "implements" | "decided_by" | "affects"
  | "tested_by" | "calls" | "imports" | "related_to"
  | "can_do" | "delegated_to";  // NEW

// Extended AssembledContext
interface AssembledContext {
  // ... existing fields ...
  handoff_results?: {
    id: string;
    summary: string;
    from_agent: string;
    scope: string;
    created_at: string;
  }[];
  available_agents?: {
    name: string;
    capabilities: string[];
    status: string;
  }[];
}
```

### 2. BlackboardEngine -- Minor Extension

No code changes needed. Delegation uses existing `post()` with `entry_type: "need"`. The structured delegation metadata goes in the `detail` field. The `DelegationMatcher` (in agent-engine.ts) handles parsing delegation metadata from blackboard entries.

### 3. ContextAssembler -- Extended Assembly

Add handoff awareness to `assemble()`:

```typescript
// In assemble(), after existing logic:
// NEW: Include relevant handoff results
if (this.handoffStore) {
  const handoffs = await this.handoffStore.getByScope(scope);
  const pendingHandoffs = handoffs.filter(h => h.status === "pending");
  // Add to assembled context (subject to token budget)
}

// NEW: Include available agents for delegation suggestions
if (this.agentStore) {
  const agents = await this.agentStore.getActive();
  // Add summary of available agents (lightweight, always included)
}
```

### 4. lifecycle-tools.ts -- Extended Status

Add agent counts to `twining_status` output:

```typescript
// In twining_status handler:
const agentStore = new AgentStore(twiningDir);
const agents = await agentStore.getAll();
const activeAgents = agents.filter(a => a.status === "active").length;
const registeredAgents = agents.length;
// Add to result: { registered_agents, active_agents }
```

### 5. server.ts -- Wiring

```typescript
// In createServer():
import { AgentStore } from "./storage/agent-store.js";
import { HandoffStore } from "./storage/handoff-store.js";
import { AgentEngine } from "./engine/agent-engine.js";
import { registerAgentTools } from "./tools/agent-tools.js";

const agentStore = new AgentStore(twiningDir);
const handoffStore = new HandoffStore(twiningDir);

const agentEngine = new AgentEngine(
  agentStore,
  handoffStore,
  blackboardEngine,
  contextAssembler,
  graphEngine,
);

// Extended context assembler with handoff awareness
const contextAssembler = new ContextAssembler(
  blackboardStore, decisionStore, searchEngine, config,
  graphEngine, planningBridge,
  handoffStore, agentStore,  // NEW optional params
);

registerAgentTools(server, agentEngine);
```

### 6. init.ts -- New Directories

```typescript
// In initTwiningDir():
fs.mkdirSync(path.join(twiningDir, "agents"), { recursive: true });
fs.mkdirSync(path.join(twiningDir, "handoffs"), { recursive: true });

// Empty data files
fs.writeFileSync(
  path.join(twiningDir, "agents", "registry.json"),
  JSON.stringify([], null, 2),
);
fs.writeFileSync(
  path.join(twiningDir, "handoffs", "index.json"),
  JSON.stringify([], null, 2),
);
```

### 7. Dashboard API -- New Endpoints

```typescript
// In api-routes.ts:
// GET /api/agents -- list all registered agents
// GET /api/handoffs -- list handoff index
// GET /api/handoffs/:id -- get full handoff record
```

### 8. Dashboard UI -- New Tab

Add "Agents" tab to dashboard showing:
- Agent registry with status indicators
- Pending delegations (needs without handoffs)
- Handoff history (completed delegations)

## Patterns to Follow

### Pattern 1: Upsert by Name (Agent Registry)

Mirrors the existing GraphStore entity upsert pattern. Re-registering an agent with the same name updates capabilities and resets `last_active`. This handles:
- Session restarts (agent re-registers on new session)
- Capability changes (agent gains new skills)
- Multi-session agents (same logical agent across Claude Code sessions)

```typescript
async upsert(input: Omit<AgentRecord, "id" | "registered_at" | "status">): Promise<AgentRecord> {
  const existing = agents.find(a => a.name === input.name);
  if (existing) {
    existing.capabilities = input.capabilities;
    existing.last_active = new Date().toISOString();
    existing.scope = input.scope;
    existing.metadata = { ...existing.metadata, ...input.metadata };
    // write back
    return existing;
  }
  // create new
  const record: AgentRecord = {
    ...input,
    id: generateId(),
    registered_at: new Date().toISOString(),
    status: "active",
  };
  agents.push(record);
  return record;
}
```

### Pattern 2: Inferred Liveness (No Heartbeats)

Instead of requiring agents to send heartbeat messages, infer liveness from `last_active` timestamps. Update `last_active` whenever an agent calls any Twining tool (via agent_id matching). Status thresholds:

```typescript
private inferStatus(lastActive: string): "active" | "idle" | "gone" {
  const ageMs = Date.now() - new Date(lastActive).getTime();
  const ageMinutes = ageMs / (1000 * 60);
  if (ageMinutes < 5) return "active";
  if (ageMinutes < 60) return "idle";
  return "gone";
}
```

**Why no heartbeats:** MCP is request/response -- there's no background channel for heartbeats. Agents would have to call a dedicated heartbeat tool, which wastes tokens and clutters tool lists. Inferring from existing activity is free.

### Pattern 3: Delegation via Blackboard (Not Direct Routing)

Delegations are posted as blackboard "need" entries with structured metadata. This preserves the blackboard pattern's core principle: agents self-select into work based on visible shared state. The `twining_delegate` tool is a convenience that:
1. Posts the need with structured capabilities
2. Queries the registry for matching agents
3. Returns suggestions (but does NOT assign work)

The actual delegation happens when an agent reads the need and chooses to fulfill it. This matches how Claude Code subagents and agent teams already work -- there's no forced assignment.

### Pattern 4: Context Snapshot on Handoff

When an agent creates a handoff, the system automatically snapshots the relevant context (active decisions, warnings) at that moment. This prevents the "context drift" problem where:
- Agent A posts a handoff
- Time passes, decisions change
- Agent B reads the handoff but the context has shifted

The snapshot preserves decision IDs and warning IDs so Agent B can verify whether those decisions are still active.

### Pattern 5: Optional Constructor Parameters (Existing Pattern)

Follow the established pattern from `ContextAssembler` where new dependencies are optional constructor parameters with null defaults:

```typescript
constructor(
  blackboardStore: BlackboardStore,
  decisionStore: DecisionStore,
  searchEngine: SearchEngine | null,
  config: TwiningConfig,
  graphEngine?: GraphEngine | null,
  planningBridge?: PlanningBridge | null,
  handoffStore?: HandoffStore | null,   // NEW, optional
  agentStore?: AgentStore | null,       // NEW, optional
)
```

This ensures backward compatibility -- existing tests don't break because they don't pass the new params.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Agent-to-Agent Direct Communication

**What:** Building a messaging system where agents send messages directly to each other.
**Why bad:** MCP is request/response from client to server. There's no push channel. Agents can't receive notifications. Any "messaging" would require polling, which is exactly what the blackboard already provides.
**Instead:** Use the blackboard. Post needs, post offers, post answers. Agents read the blackboard to discover what's happening. This is already Twining's core pattern.

### Anti-Pattern 2: Capability Ontology/Taxonomy

**What:** Defining a fixed taxonomy of agent capabilities with hierarchical categories.
**Why bad:** Over-engineering. Capabilities are contextual and evolve. A fixed taxonomy creates artificial constraints and requires maintenance.
**Instead:** Free-form string tags with substring matching. `["typescript", "testing"]` matches a need for `["testing"]`. Simple, flexible, no governance overhead.

### Anti-Pattern 3: Forced Task Assignment

**What:** Having `twining_delegate` automatically assign work to a specific agent.
**Why bad:** Violates the blackboard pattern's self-selection principle. MCP can't push tasks to agents. Assigned agents might not exist anymore. Creates coupling between delegator and delegatee.
**Instead:** Post the need with capability requirements. Return suggestions. The consuming agent reads the blackboard and voluntarily picks up work.

### Anti-Pattern 4: Separate Delegation Queue

**What:** Creating a separate data structure/file for delegation requests.
**Why bad:** Duplicates the blackboard. Creates two places to look for needs. Fragments the context assembly pipeline.
**Instead:** Delegations are blackboard entries with structured metadata. One system, one query path, one context assembly pipeline.

### Anti-Pattern 5: Heavy Handoff Records

**What:** Storing full context assembly output in every handoff record.
**Why bad:** Handoff records become enormous. Most of the context is already in the decisions and blackboard entries referenced by ID.
**Instead:** Store IDs and summaries in the context snapshot. The consuming agent can use `twining_assemble` to get full context, with the handoff's scope as input.

## Build Order (Dependencies)

Build new components bottom-up, following the existing pattern:

```
Phase 1: Foundation
  1. types.ts         -- Add AgentRecord, HandoffRecord, extended types
  2. init.ts          -- Add agents/ and handoffs/ directories
  3. agent-store.ts   -- Agent registry CRUD with upsert-by-name
  4. handoff-store.ts -- Handoff CRUD with index management

Phase 2: Engine
  5. agent-engine.ts  -- Registration, discovery, delegation matching, handoff creation
     - Depends on: agent-store, handoff-store, blackboard-engine, context-assembler, graph-engine

Phase 3: Integration
  6. context-assembler.ts -- Extend with handoff awareness (optional params)
  7. lifecycle-tools.ts   -- Extend status with agent counts
  8. agent-tools.ts       -- New MCP tool handlers
  9. server.ts            -- Wire everything up

Phase 4: Dashboard
  10. api-routes.ts       -- Add /api/agents, /api/handoffs endpoints
  11. Dashboard UI        -- Add Agents tab with registry + delegations + handoffs
```

**Why this order:**
- Phase 1 has zero dependencies on existing engine modules -- pure storage + types
- Phase 2 depends on Phase 1 stores + existing engines (which are stable)
- Phase 3 modifies existing modules minimally (optional params, additive output)
- Phase 4 is pure read-only display, depends on Phase 1 stores

## Scalability Considerations

| Concern | At 5 agents | At 20 agents | At 100 agents |
|---------|------------|--------------|---------------|
| Registry file size | ~2KB | ~8KB | ~40KB |
| Discovery query | <1ms (linear scan) | <1ms | ~5ms (consider indexing) |
| Capability matching | Substring scan, instant | Fast enough | Consider capability index |
| Handoff records | Few per session | Moderate | Archive old handoffs with blackboard |
| Liveness inference | Negligible | Negligible | Negligible (timestamp comparison) |

For Twining's use case (typically 1-10 agents), all operations are well within performance bounds. The registry is a single JSON file read into memory, capability matching is O(agents * capabilities), and handoff lookups use the same index pattern as decisions.

## Interaction with Claude Code Features

### Subagents
Claude Code subagents get their own context window. When a subagent registers with Twining and uses `twining_assemble`, it automatically receives context from the main agent's decisions and other subagents' findings. This is the primary coordination pathway.

### Agent Teams
Claude Code's experimental agent teams feature (shared task lists + mailbox) operates at the session level. Twining operates at the project state level. They're complementary:
- Agent teams handle real-time task assignment within a session
- Twining handles persistent state, decisions, and cross-session knowledge
- An agent team member can use `twining_delegate` to create a need that persists beyond the team's lifetime
- Twining handoffs capture context snapshots that survive agent team dissolution

### Cross-Session Continuity
The agent registry survives session restarts. When a new Claude Code session starts and registers with Twining, it can discover what was delegated by previous sessions and pick up pending work via handoffs.

## Sources

- [Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture](https://arxiv.org/html/2507.01701v1) -- Blackboard control mechanism, agent selection, shared memory design
- [Four Design Patterns for Event-Driven Multi-Agent Systems](https://www.confluent.io/blog/event-driven-multi-agent-systems/) -- Blackboard vs orchestrator vs market patterns, arbiter evolution
- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents) -- Claude Code subagent architecture, context isolation, delegation patterns
- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) -- Agent teams architecture, shared task lists, mailbox messaging
- [MCP Registry](https://github.com/modelcontextprotocol/registry) -- MCP capability discovery patterns
- [Best Practices for Multi-Agent Orchestration and Reliable Handoffs](https://skywork.ai/blog/ai-agent-orchestration-best-practices-handoffs/) -- Handoff reliability, context packaging
- [Advancing Multi-Agent Systems Through Model Context Protocol](https://arxiv.org/abs/2504.21030) -- MCP-based multi-agent coordination architecture
- Twining codebase analysis (server.ts, context-assembler.ts, blackboard.ts, graph.ts, types.ts, all stores)
