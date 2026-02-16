# Twining: Agent Coordination MCP Server
## Comprehensive Design & Implementation Specification
### *Separate threads, stronger together*

---

## 1. Project Overview

### 1.1 What Twining Is
Twining is an MCP server for Claude Code that provides a shared coordination layer between AI agents (main sessions, subagents, Task() clones, and cross-session workflows). It combines a blackboard-pattern shared state system, a first-class decision log with rationale tracking, a selective context assembler, a lightweight knowledge graph, and local semantic search — all backed by plain files that are git-trackable and human-inspectable.

### 1.2 The Problem
Multi-agent coding workflows suffer from a fundamental tension: fresh context windows prevent quality degradation but create information silos. Decisions made by one agent are invisible to the next. The system optimizes locally while failing globally. Every handoff is lossy because agents share *what* was done but not *why*.

### 1.3 Design Principles

1. **The Blackboard, Not the Pipeline** — Agents self-select into work based on visible shared state. The system broadcasts needs; agents volunteer.
2. **Decisions Over Outputs** — Every action carries reasoning, constraints, trade-offs, and rejected alternatives. The *why* is more important than the *what*.
3. **Selective Injection, Not Firehose** — Agents query for relevant context. The assembler builds tailored packages for each task.
4. **File-Native** — All state lives as `.jsonl` and `.json` in `.twining/`. `jq`-queryable, git-trackable, human-inspectable. No external databases.
5. **Zero-Config Progressive Adoption** — Valuable day one as persistent memory. Multi-agent coordination layers on without reconfiguration.

### 1.4 Technology Stack
- **Language:** TypeScript
- **Runtime:** Node.js (>=18)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Embeddings:** `onnxruntime-node` with `all-MiniLM-L6-v2` (local, no API calls)
- **ID Generation:** `ulid` (temporally sortable)
- **Package Manager:** npm
- **Package Name:** `twining-mcp`

---

## 2. Architecture

### 2.1 High-Level Architecture

```
┌────────────────────────────────────────────────────────┐
│                  Twining MCP Server                     │
├────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐ ┌───────────────┐ ┌───────────────┐  │
│  │  Blackboard   │ │  Decision     │ │  Context       │  │
│  │  Engine       │ │  Tracker      │ │  Assembler     │  │
│  └──────┬───────┘ └──────┬────────┘ └──────┬────────┘  │
│         │                │                  │            │
│  ┌──────┴────────────────┴──────────────────┴────────┐  │
│  │              Knowledge Graph                       │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────┴────────────────────────────┐  │
│  │              Embedding Index                       │  │
│  │         (all-MiniLM-L6-v2 via ONNX)               │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────┴────────────────────────────┐  │
│  │           File Storage Layer (.twining/)           │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
├────────────────────────────────────────────────────────┤
│                   MCP Tool Surface                       │
│                                                          │
│  Blackboard: post, read, query, recent                  │
│  Decisions:  decide, why, trace, reconsider             │
│  Context:    assemble, summarize, what_changed          │
│  Graph:      add_entity, add_relation, neighbors, path  │
│  Lifecycle:  archive, status                            │
│                                                          │
└────────────────────────────────────────────────────────┘
```

### 2.2 File Structure

```
.twining/
├── config.yml                    # Project configuration
├── blackboard.jsonl              # Append-only shared state stream
├── decisions/
│   ├── index.json                # Decision index (summaries + metadata)
│   └── {ulid}.json               # Individual decision records
├── graph/
│   ├── entities.json             # Knowledge graph entities
│   └── relations.json            # Knowledge graph relations
├── embeddings/
│   ├── blackboard.index          # Embedding index for blackboard entries
│   └── decisions.index           # Embedding index for decisions
├── archive/
│   └── {date}-blackboard.jsonl   # Archived blackboard entries
└── .gitignore                    # Ignore embeddings/*.index, archive/
```

### 2.3 Directory Initialization

On first tool call, if `.twining/` does not exist, the server creates it with default config and empty data files. The `.gitignore` excludes binary embedding indexes and archives but includes all JSON/JSONL state files.

Default `.twining/.gitignore`:
```
embeddings/*.index
archive/
```

Default `.twining/config.yml`:
```yaml
version: 1
project_name: ""  # auto-detected from directory name
embedding_model: "all-MiniLM-L6-v2"
archive:
  auto_archive_on_commit: true
  auto_archive_on_context_switch: true
  max_blackboard_entries_before_archive: 500
context_assembly:
  default_max_tokens: 4000
  priority_weights:
    recency: 0.3
    relevance: 0.4
    decision_confidence: 0.2
    warning_boost: 0.1
conflict_resolution: "human"  # "human" = flag for human review
```

---

## 3. Data Models

### 3.1 Blackboard Entry

```typescript
interface BlackboardEntry {
  id: string;                     // ULID (temporally sortable)
  timestamp: string;              // ISO 8601
  agent_id: string;               // Identifier for the posting agent
  entry_type:
    | "need"                      // "I need X to proceed"
    | "offer"                     // "I can provide X"
    | "finding"                   // "I discovered X"
    | "decision"                  // "I decided X because Y" (also creates Decision record)
    | "constraint"                // "X limits our options"
    | "question"                  // "Does anyone know X?"
    | "answer"                    // "Re: [ref], here is X"
    | "status"                    // "Task X is now Y"
    | "artifact"                  // "I produced file X"
    | "warning";                  // "Watch out for X"

  tags: string[];                 // Domain tags for filtering (e.g., ["auth", "backend"])
  relates_to?: string[];          // IDs of related entries
  scope: string;                  // File path, module name, or "project"

  summary: string;                // One-line for scanning (required, max 200 chars)
  detail: string;                 // Full context

  // Populated by server
  embedding_id?: string;          // Reference into embedding index
}
```

**Storage:** Each entry is one line in `.twining/blackboard.jsonl`.

### 3.2 Decision

```typescript
interface Decision {
  id: string;                     // ULID
  timestamp: string;              // ISO 8601
  agent_id: string;

  // What was decided
  domain: string;                 // "architecture" | "implementation" | "testing" | "dependency" | "api" | "data" | custom
  scope: string;                  // What part of the codebase this affects
  summary: string;                // One-line decision statement

  // Why it was decided
  context: string;                // Situation that prompted this decision
  rationale: string;              // Reasoning for the choice
  constraints: string[];          // What limited the options

  alternatives: {
    option: string;
    pros: string[];
    cons: string[];
    reason_rejected: string;
  }[];

  // Traceability
  depends_on: string[];           // IDs of prerequisite decisions
  supersedes?: string;            // ID of decision this replaces
  confidence: "high" | "medium" | "low";
  status: "active" | "provisional" | "superseded" | "overridden";
  reversible: boolean;

  // What it affects
  affected_files: string[];
  affected_symbols: string[];     // Function/class names

  // Human override
  overridden_by?: string;         // Human who overrode this
  override_reason?: string;       // Why it was overridden
}
```

**Storage:** Individual files in `.twining/decisions/{ulid}.json`. Index in `.twining/decisions/index.json` containing summaries and metadata for fast lookup.

### 3.3 Knowledge Graph Entity

```typescript
interface Entity {
  id: string;                     // ULID
  name: string;                   // Human-readable name
  type:
    | "module"
    | "function"
    | "class"
    | "file"
    | "concept"
    | "pattern"
    | "dependency"
    | "api_endpoint";
  properties: Record<string, string>;
  created_at: string;
  updated_at: string;
}
```

### 3.4 Knowledge Graph Relation

```typescript
interface Relation {
  id: string;
  source: string;                 // Entity ID
  target: string;                 // Entity ID
  type:
    | "depends_on"
    | "implements"
    | "decided_by"
    | "affects"
    | "tested_by"
    | "calls"
    | "imports"
    | "related_to";
  properties: Record<string, string>;
  created_at: string;
}
```

**Storage:** `.twining/graph/entities.json` (array) and `.twining/graph/relations.json` (array).

### 3.5 Assembled Context

```typescript
interface AssembledContext {
  assembled_at: string;
  task: string;
  scope: string;
  token_estimate: number;

  active_decisions: {
    id: string;
    summary: string;
    rationale: string;
    confidence: string;
    affected_files: string[];
  }[];

  open_needs: Pick<BlackboardEntry, "id" | "summary" | "scope" | "timestamp">[];
  recent_findings: Pick<BlackboardEntry, "id" | "summary" | "detail" | "scope" | "timestamp">[];
  active_warnings: Pick<BlackboardEntry, "id" | "summary" | "detail" | "scope" | "timestamp">[];
  recent_questions: Pick<BlackboardEntry, "id" | "summary" | "scope" | "timestamp">[];

  related_entities: {
    name: string;
    type: string;
    relations: string[];          // Human-readable relation descriptions
  }[];
}
```

This is an ephemeral output, not stored persistently.

---

## 4. MCP Tool Definitions

### 4.1 Blackboard Tools

#### `twining_post`
Post an entry to the shared blackboard.

**Input:**
```typescript
{
  entry_type: string;             // required: one of the entry types
  summary: string;                // required: one-line summary (max 200 chars)
  detail?: string;                // optional: full context
  tags?: string[];                // optional: domain tags
  scope?: string;                 // optional: defaults to "project"
  relates_to?: string[];          // optional: IDs of related entries
  agent_id?: string;              // optional: defaults to "main"
}
```

**Returns:** `{ id: string, timestamp: string }`

**Side effects:**
- Appends entry to `blackboard.jsonl`
- Generates and stores embedding for `summary + detail`
- If `entry_type === "decision"`, prompts for rationale fields and creates a Decision record

#### `twining_read`
Read blackboard entries with optional filters.

**Input:**
```typescript
{
  entry_types?: string[];         // Filter by type
  tags?: string[];                // Filter by tags (OR match)
  scope?: string;                 // Filter by scope (prefix match)
  since?: string;                 // ISO 8601 timestamp
  limit?: number;                 // Max entries (default: 50)
}
```

**Returns:** `{ entries: BlackboardEntry[], total_count: number }`

#### `twining_query`
Semantic search across blackboard entries.

**Input:**
```typescript
{
  query: string;                  // Natural language query
  entry_types?: string[];         // Optional type filter
  limit?: number;                 // Max results (default: 10)
}
```

**Returns:** `{ results: { entry: BlackboardEntry, relevance: number }[] }`

#### `twining_recent`
Quick access to latest entries.

**Input:**
```typescript
{
  n?: number;                     // Number of entries (default: 20)
  entry_types?: string[];         // Optional type filter
}
```

**Returns:** `{ entries: BlackboardEntry[] }`

### 4.2 Decision Tools

#### `twining_decide`
Record a decision with full rationale.

**Input:**
```typescript
{
  domain: string;                 // required
  scope: string;                  // required
  summary: string;                // required: one-line decision statement
  context: string;                // required: what prompted this
  rationale: string;              // required: why this choice
  constraints?: string[];
  alternatives?: {
    option: string;
    pros?: string[];
    cons?: string[];
    reason_rejected: string;
  }[];
  depends_on?: string[];          // Decision IDs
  supersedes?: string;            // Decision ID being replaced
  confidence?: "high" | "medium" | "low";  // default: "medium"
  reversible?: boolean;           // default: true
  affected_files?: string[];
  affected_symbols?: string[];
  agent_id?: string;              // default: "main"
}
```

**Returns:** `{ id: string, timestamp: string }`

**Side effects:**
- Creates decision file in `decisions/{ulid}.json`
- Updates `decisions/index.json`
- Posts a "decision" entry to the blackboard
- If `supersedes` is set, marks the old decision as `status: "superseded"`
- Generates and stores embedding
- Creates/updates knowledge graph entities for affected files/symbols with "decided_by" relations

#### `twining_why`
Retrieve decision chain for a scope or file.

**Input:**
```typescript
{
  scope: string;                  // File path, module name, or symbol
}
```

**Returns:**
```typescript
{
  decisions: {
    id: string;
    summary: string;
    rationale: string;
    confidence: string;
    status: string;
    timestamp: string;
    alternatives_count: number;
  }[];
  active_count: number;
  provisional_count: number;
}
```

#### `twining_trace`
Follow the dependency chain of a decision.

**Input:**
```typescript
{
  decision_id: string;
  direction?: "upstream" | "downstream" | "both";  // default: "both"
}
```

**Returns:**
```typescript
{
  chain: {
    id: string;
    summary: string;
    depends_on: string[];
    dependents: string[];         // Decisions that depend on this one
    status: string;
  }[];
}
```

#### `twining_reconsider`
Flag a decision for review given new information.

**Input:**
```typescript
{
  decision_id: string;
  new_context: string;            // What changed that warrants reconsideration
  agent_id?: string;
}
```

**Returns:** `{ flagged: boolean, decision_summary: string }`

**Side effects:**
- Posts a "warning" entry to blackboard noting the reconsideration
- Marks the decision as `status: "provisional"` if currently "active"

#### `twining_override`
Human override of a decision.

**Input:**
```typescript
{
  decision_id: string;
  reason: string;                 // Why the human is overriding
  new_decision?: string;          // Optional: replacement decision summary
  overridden_by?: string;         // Human identifier (default: "human")
}
```

**Returns:** `{ overridden: boolean, old_summary: string }`

**Side effects:**
- Sets decision `status: "overridden"`, records `overridden_by` and `override_reason`
- Posts blackboard entry noting the override

### 4.3 Context Assembly Tools

#### `twining_assemble`
Build tailored context for a specific task.

**Input:**
```typescript
{
  task: string;                   // Description of what the agent is about to do
  scope: string;                  // File path, module, or area of codebase
  max_tokens?: number;            // Token budget (default: from config)
}
```

**Returns:** `AssembledContext` (see 3.5)

**Algorithm:**
1. Retrieve all active decisions affecting the scope (file prefix match + symbol match)
2. Retrieve all active + provisional decisions with semantic similarity to the task
3. Retrieve open "need", "warning", "question" entries in scope
4. Retrieve recent "finding" entries with semantic similarity to the task
5. Query knowledge graph for entities related to scope
6. Score each item using weighted combination: `recency * w1 + relevance * w2 + decision_confidence * w3 + warning_boost * w4`
7. Fill the token budget in priority order, estimating tokens at 4 chars per token
8. Return the assembled context

#### `twining_summarize`
High-level summary of project or scope state.

**Input:**
```typescript
{
  scope?: string;                 // Optional scope filter (default: "project")
}
```

**Returns:**
```typescript
{
  scope: string;
  active_decisions: number;
  provisional_decisions: number;
  open_needs: number;
  active_warnings: number;
  unanswered_questions: number;
  recent_activity_summary: string;  // LLM-friendly paragraph
}
```

#### `twining_what_changed`
Report changes since a given point in time.

**Input:**
```typescript
{
  since: string;                  // ISO 8601 timestamp
  scope?: string;                 // Optional scope filter
}
```

**Returns:**
```typescript
{
  new_decisions: { id: string; summary: string }[];
  new_entries: { id: string; entry_type: string; summary: string }[];
  overridden_decisions: { id: string; summary: string; reason: string }[];
  reconsidered_decisions: { id: string; summary: string }[];
}
```

### 4.4 Knowledge Graph Tools

#### `twining_add_entity`
Add an entity to the knowledge graph.

**Input:**
```typescript
{
  name: string;
  type: string;                   // Entity type
  properties?: Record<string, string>;
}
```

**Returns:** `{ id: string }`

**Side effects:** Appends to `graph/entities.json`. If entity with same name+type exists, updates it.

#### `twining_add_relation`
Add a relationship between entities.

**Input:**
```typescript
{
  source: string;                 // Entity ID or name
  target: string;                 // Entity ID or name
  type: string;                   // Relation type
  properties?: Record<string, string>;
}
```

**Returns:** `{ id: string }`

#### `twining_neighbors`
Find entities connected to a given entity.

**Input:**
```typescript
{
  entity: string;                 // Entity ID or name
  depth?: number;                 // Traversal depth (default: 1, max: 3)
  relation_types?: string[];      // Filter by relation type
}
```

**Returns:**
```typescript
{
  center: Entity;
  neighbors: {
    entity: Entity;
    relation: string;
    direction: "outgoing" | "incoming";
  }[];
}
```

#### `twining_graph_query`
Search entities by name or properties.

**Input:**
```typescript
{
  query: string;                  // Search term
  entity_types?: string[];        // Filter by type
  limit?: number;                 // Default: 10
}
```

**Returns:** `{ entities: Entity[] }`

### 4.5 Lifecycle Tools

#### `twining_archive`
Archive old blackboard entries. Called automatically on commit/context-switch if configured, or manually.

**Input:**
```typescript
{
  before?: string;                // Archive entries before this timestamp
  keep_decisions?: boolean;       // Keep decision-type entries (default: true)
  summarize?: boolean;            // Generate summary of archived entries (default: true)
}
```

**Returns:**
```typescript
{
  archived_count: number;
  archive_file: string;
  summary?: string;               // If summarize was true
}
```

**Side effects:**
- Moves entries from `blackboard.jsonl` to `archive/{date}-blackboard.jsonl`
- If `summarize`, posts a "finding" entry with summary of archived content
- Rebuilds embedding index for remaining entries

#### `twining_status`
Overall health check of the Twining state.

**Input:** none

**Returns:**
```typescript
{
  project: string;
  blackboard_entries: number;
  active_decisions: number;
  provisional_decisions: number;
  graph_entities: number;
  graph_relations: number;
  last_activity: string;
  needs_archiving: boolean;
}
```

---

## 5. Embedding System

### 5.1 Model
Use `all-MiniLM-L6-v2` via `onnxruntime-node`. This model produces 384-dimensional embeddings and runs entirely locally with no API calls. The ONNX model file (~23MB) is bundled or downloaded on first use.

### 5.2 Tokenization
Use the model's tokenizer (available as a JSON vocabulary file). For token estimation in context assembly, use the approximation of 4 characters per token.

### 5.3 Index Structure
Store embeddings as a simple JSON index:

```typescript
interface EmbeddingIndex {
  model: string;
  dimension: number;
  entries: {
    id: string;                   // Reference to blackboard entry or decision
    vector: number[];             // 384-dimensional float array
  }[];
}
```

**Search:** Cosine similarity, brute-force over the index. For typical project sizes (<10k entries), this is fast enough. Optimize later if needed.

### 5.4 Embedding Triggers
Embeddings are generated for:
- Every blackboard entry: embed `summary + " " + detail`
- Every decision: embed `summary + " " + rationale + " " + context`

### 5.5 TODO: Context Assembly Relevance Algorithm
The current scoring is a simple weighted combination. This is a placeholder — invest in a proper relevance algorithm that considers:
- Semantic similarity (embedding cosine distance)
- Temporal recency (exponential decay)
- Scope proximity (exact match > prefix match > project-level)
- Decision confidence weighting
- Entry type boosting (warnings > decisions > findings > status)
- Graph connectivity (entities with more relations to scope rank higher)

Track this as an ongoing improvement area. The initial weights in config.yml are a starting point.

---

## 6. Archive & Summarization

### 6.1 Triggers
Archiving happens:
1. **On git commit** (detected via hook, see section 8): Archive entries older than the previous commit
2. **On context switch** (detected when user gives a new high-level instruction unrelated to current scope): Claude can call `twining_archive` explicitly
3. **On threshold** (when blackboard exceeds `max_blackboard_entries_before_archive`)
4. **On manual invocation**

### 6.2 Archive Process
1. Select entries to archive based on timestamp/threshold
2. Keep all "decision" type entries in the active blackboard (decisions are permanent)
3. Move selected entries to `archive/{YYYY-MM-DD}-blackboard.jsonl`
4. If `summarize: true`, concatenate summaries of archived entries and post a single "finding" entry: "Archive summary: {count} entries archived covering {topics}. Key items: {top 5 summaries}"
5. Rebuild embedding index for remaining active entries

### 6.3 Decision entries are never archived
Decision entries remain in the active blackboard indefinitely. They are the permanent record. Only their corresponding full Decision files in `decisions/` contain the complete rationale.

---

## 7. Conflict Detection

### 7.1 Detection
When `twining_decide` is called, check for existing active decisions in the same scope. If a new decision contradicts (same domain + same scope + different summary), flag it.

### 7.2 Resolution
Per design principle: human-in-the-loop for now.

When a conflict is detected:
1. Post a "warning" entry to the blackboard: "Potential conflict: Decision {new_id} in scope {scope} may conflict with existing decision {existing_id}"
2. Include both summaries and rationales in the warning detail
3. Mark the new decision as `status: "provisional"`
4. Return the conflict information in the `twining_decide` response so Claude can alert the user

The user resolves via `twining_override` on the decision they want to reject.

---

## 8. Claude Code Integration

### 8.1 CLAUDE.md Instructions

Add to project root `CLAUDE.md`:

```markdown
## Twining Integration

This project uses Twining for shared agent coordination. Follow these practices:

### Before modifying code:
- Call `twining_why` on the file/module you're about to change to understand prior decisions
- Call `twining_assemble` with your task description to get relevant context

### After making significant changes:
- Call `twining_decide` for any architectural or non-trivial implementation choices
- Always include rationale and at least one rejected alternative
- Post findings to the blackboard for anything surprising or noteworthy
- Post warnings for any gotchas or things the next agent should know

### When starting a new task:
- Call `twining_assemble` with the task description and scope
- Check for open "need" entries that you might be able to resolve
- Check for "warning" entries in your scope

### Decision confidence:
- "high" = well-researched, strong rationale, tested
- "medium" = reasonable choice, some uncertainty
- "low" = best guess, needs validation

### Provisional decisions:
- Decisions marked "provisional" may be overridden by the user
- Always check decision status before relying on provisional decisions
- If you need to change a provisional decision, use `twining_reconsider`
```

### 8.2 Hook Configurations

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "type": "command",
        "command": "echo '{\"tool\": \"twining_post\", \"entry_type\": \"status\", \"summary\": \"Subagent completed task\"}' >> .twining/pending-posts.jsonl"
      }
    ],
    "PreCompact": [
      {
        "type": "command",
        "command": "echo 'Context compacting — consider calling twining_archive' >&2"
      }
    ]
  }
}
```

Note: Hook integration is limited in Phase 1. The pending-posts pattern allows hooks to queue entries that the MCP server picks up on next tool call.

### 8.3 Subagent Template

Create `.claude/agents/twining-aware.md`:

```markdown
---
name: twining-aware-worker
description: A subagent that coordinates through Twining shared state
tools: Read, Write, Edit, Bash, twining_assemble, twining_post, twining_decide, twining_why, twining_query
---

You are a specialized worker agent. Before starting any task:

1. Call `twining_assemble` with your task description and scope to get shared context
2. Read the assembled context carefully — it contains decisions, warnings, and needs from other agents
3. Check if there are any open "need" entries you should address

While working:
- Post "finding" entries for anything surprising
- Post "warning" entries for gotchas
- Record decisions with `twining_decide` for any non-trivial choices

When finishing:
- Post a "status" entry summarizing what you did
- Post any "need" entries for work that should follow
- Ensure all significant decisions are recorded
```

### 8.4 Git Hook (Optional)

Create `.git/hooks/post-commit` (or configure via Claude Code hooks):

```bash
#!/bin/bash
# Auto-archive old Twining entries on commit
if [ -d ".twining" ]; then
  # Queue an archive request
  echo '{"action": "archive", "trigger": "commit"}' >> .twining/pending-actions.jsonl
fi
```

---

## 9. Source Code Structure

```
twining-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE                       # MIT
├── src/
│   ├── index.ts                  # Entry point, MCP server setup
│   ├── server.ts                 # MCP tool registration and dispatch
│   ├── config.ts                 # Configuration loading and defaults
│   ├── storage/
│   │   ├── file-store.ts         # File I/O utilities (read/write/append JSONL, JSON)
│   │   ├── blackboard-store.ts   # Blackboard CRUD operations
│   │   ├── decision-store.ts     # Decision CRUD + index management
│   │   └── graph-store.ts        # Knowledge graph CRUD
│   ├── engine/
│   │   ├── blackboard.ts         # Blackboard business logic
│   │   ├── decisions.ts          # Decision logic, conflict detection
│   │   ├── context-assembler.ts  # Context assembly algorithm
│   │   ├── archiver.ts           # Archive and summarization logic
│   │   └── graph.ts              # Graph traversal and query
│   ├── embeddings/
│   │   ├── embedder.ts           # ONNX model loading and inference
│   │   ├── index-manager.ts      # Embedding index CRUD
│   │   └── search.ts             # Cosine similarity search
│   ├── tools/
│   │   ├── blackboard-tools.ts   # MCP tool handlers for blackboard
│   │   ├── decision-tools.ts     # MCP tool handlers for decisions
│   │   ├── context-tools.ts      # MCP tool handlers for context assembly
│   │   ├── graph-tools.ts        # MCP tool handlers for knowledge graph
│   │   └── lifecycle-tools.ts    # MCP tool handlers for archive, status
│   └── utils/
│       ├── ids.ts                # ULID generation
│       ├── tokens.ts             # Token estimation
│       └── types.ts              # Shared TypeScript interfaces
├── models/
│   └── .gitkeep                  # ONNX model downloaded here on first use
└── test/
    ├── blackboard.test.ts
    ├── decisions.test.ts
    ├── context-assembler.test.ts
    ├── graph.test.ts
    ├── embeddings.test.ts
    └── integration.test.ts
```

---

## 10. Implementation Notes

### 10.1 File Locking
Use advisory file locking (`proper-lockfile` npm package) for all write operations to prevent corruption from concurrent agent access. All writes to `blackboard.jsonl` and JSON files should acquire a lock, write, and release.

### 10.2 ULID Usage
All IDs are ULIDs, which are lexicographically sortable by creation time. This means reading `blackboard.jsonl` and sorting by ID gives temporal order without parsing timestamps.

### 10.3 Lazy Embedding Initialization
The ONNX model (~23MB) should be downloaded lazily on first embedding operation, not on server startup. If embeddings fail (e.g., ONNX not available on platform), fall back to keyword-based search with a warning. The server should never fail to start because of embedding issues.

### 10.4 Token Estimation
Use the simple heuristic of `text.length / 4` for token estimation. This is approximate but sufficient for context budget management.

### 10.5 Scope Matching
Scope matching uses prefix semantics:
- `"src/auth/jwt.ts"` matches scope `"src/auth/"` and `"src/auth/jwt.ts"`
- `"project"` matches everything
- Symbols (function/class names) are matched exactly against `affected_symbols`

### 10.6 Error Handling
All tool handlers should catch errors and return structured error responses rather than crashing:
```typescript
{ error: true, message: "...", code: "FILE_WRITE_ERROR" | "EMBEDDING_FAILED" | ... }
```

### 10.7 Startup Behavior
On server start:
1. Check if `.twining/` directory exists in the project root
2. If not, create it with default config and empty data files
3. Load config
4. Lazily initialize embedding model on first embedding-requiring operation
5. Process any pending actions from `.twining/pending-actions.jsonl` and `.twining/pending-posts.jsonl`
6. Register all MCP tools

---

## 11. Installation & Usage

### 11.1 Installation
```bash
# Add to Claude Code as project-level MCP server
claude mcp add twining -- npx twining-mcp --project $(pwd)

# Or globally
claude mcp add twining -- npx twining-mcp
```

### 11.2 Verification
```bash
# In Claude Code
/status
# Should show "twining" in MCP servers list

# Or ask Claude:
"What's the current twining status?"
# Claude calls twining_status and reports
```

### 11.3 First Use
Simply start using Claude Code. On the first Twining tool call, the `.twining/` directory is created automatically. Start with recording decisions:

```
You: "Refactor the auth module to use JWT instead of sessions"

Claude: [calls twining_assemble("refactor auth to JWT", "src/auth/")]
        [no prior context — this is the first use]
        [does the refactoring work]
        [calls twining_decide({
          domain: "architecture",
          scope: "src/auth/",
          summary: "Switched from session-based auth to stateless JWT",
          context: "User requested refactoring for horizontal scaling support",
          rationale: "JWT enables stateless auth, eliminating server-side session storage and enabling horizontal scaling without sticky sessions",
          alternatives: [{
            option: "Keep sessions with Redis backing store",
            pros: ["Simpler token management", "Easy invalidation"],
            cons: ["Adds Redis infrastructure dependency", "Still requires session affinity for WebSocket connections"],
            reason_rejected: "Adds infrastructure complexity counter to the scaling goal"
          }],
          confidence: "high",
          affected_files: ["src/auth/middleware.ts", "src/auth/token.ts", "src/auth/types.ts"]
        })]
```

---

## 12. Future Phases (Out of Scope for Phase 1)

These are documented for architectural awareness but should NOT be built in Phase 1:

### Phase 2: Multi-Agent Coordination
- Agent registration and capability matching
- Self-selection task routing via "need"/"offer" matching
- Agent heartbeat and status tracking

### Phase 3: Integrations
- Serena MCP integration for automatic code entity population
- GSD `.planning/` state synchronization
- Git commit linking (auto-tag decisions with commit hashes)
- Web dashboard for human oversight

### Phase 4: Advanced Intelligence
- Improved relevance algorithm with learned weights
- Automatic decision conflict detection via embedding similarity
- Cross-repo Twining state via shared git repos
- Decision impact analysis ("what breaks if we change this decision?")

---

## 13. Testing Strategy

### 13.1 Unit Tests
- Each store module (blackboard, decision, graph) tested independently with temporary directories
- Context assembler tested with fixture data
- Embedding search tested with known vectors
- Conflict detection tested with overlapping scope scenarios

### 13.2 Integration Tests
- Full tool call flows: post -> read -> query
- Decision chain: decide -> why -> trace
- Context assembly with mixed blackboard + decision + graph data
- Archive flow: post entries -> archive -> verify summary + remaining entries

### 13.3 Test Fixtures
Provide a `.twining-test/` directory with pre-populated state for reproducible testing.

---

## 14. Open TODOs

- [ ] Relevance algorithm needs investment beyond simple weighted scoring — track signals, experiment with approaches
- [ ] Evaluate whether `proper-lockfile` is sufficient or if we need sqlite WAL for concurrent access at scale
- [ ] Design the pending-posts/pending-actions pattern more robustly for hook integration
- [ ] Consider adding a `twining_search_decisions` tool for finding decisions by keyword without knowing scope
- [ ] Profile embedding performance on large blackboards (>1000 entries) and optimize if needed
- [ ] Add `twining_export` tool to dump state as a single markdown document for human review
