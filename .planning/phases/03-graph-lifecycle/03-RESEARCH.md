# Phase 3: Graph + Lifecycle - Research

**Researched:** 2026-02-16
**Domain:** Knowledge graph CRUD, decision lifecycle management, blackboard archiving, status reporting
**Confidence:** HIGH

## Summary

Phase 3 adds four capability clusters to the existing Twining codebase: (1) a knowledge graph for code entities with traversal and query, (2) full decision lifecycle including trace, reconsider, override, and conflict detection, (3) blackboard archiving with summary generation, and (4) enhanced status/health reporting. All four clusters build on the existing storage, engine, and tool patterns established in Phases 1 and 2.

The implementation is entirely internal to the existing codebase with no new external dependencies. The data models (`Entity`, `Relation`) and tool signatures (`twining_add_entity`, `twining_add_relation`, `twining_neighbors`, `twining_graph_query`, `twining_trace`, `twining_reconsider`, `twining_override`, `twining_archive`, enhanced `twining_status`) are fully specified in the design spec. The storage patterns (JSON files with `proper-lockfile`, readJSON/writeJSON from `file-store.ts`) are already proven. The main technical work is implementing graph traversal (BFS with depth limit), conflict detection (scope+domain matching), archive file operations (move entries between JSONL files), and template-based summarization.

**Primary recommendation:** Build bottom-up in the established order: graph-store.ts (storage), then graph.ts + archiver.ts + decision engine extensions (engine), then graph-tools.ts + lifecycle-tools.ts extensions + decision-tools.ts extensions (tools), then wire everything into server.ts and context-assembler.ts.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Conflict detection behavior:** New decision saved as provisional, warning posted, agent keeps working. Human resolves later via twining_override.

### Claude's Discretion
- **Auto-population scope:** Whether decisions-only or decisions+findings auto-create graph entities. Claude picks the most useful level.
- **Entity deduplication:** Merge (upsert) vs always-create-new strategy for same name+type entities.
- **Relationship inference:** Whether to auto-create 'related_to' relations from shared scope, or keep relations explicit-only.
- **Graph search approach:** Name/property matching vs semantic search for graph_query tool.
- **Conflict detection strictness:** Exact scope match vs prefix overlap for triggering conflicts.
- **Reconsideration cascade:** Whether flagging a decision as provisional also cascades to downstream dependents.
- **Override flow:** Whether twining_override auto-creates a replacement decision when new_decision text is provided.
- **Summarization method:** Template-based vs concatenation vs hybrid approach for archive summaries (no LLM available in server).
- **Archive triggers:** Which of the spec triggers to implement (manual, threshold, commit hook, context switch).
- **Archive searchability:** Whether archived entries remain in the embedding index or are removed.
- **Protected entry types:** Whether any types beyond decisions are protected from archiving.
- **Status depth:** Whether twining_status includes actionable warnings (stale provisionals, unanswered questions) beyond basic counts.
- **Archive threshold logic:** Direct config value vs percentage-based early warning.
- **Graph health in status:** Whether to report disconnected entities, orphan relations, graph density.
- **Status summary string:** Whether to include a human-readable summary alongside structured data.

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GRPH-01 | Agent can add entities to the knowledge graph | GraphStore.addEntity() with upsert on name+type; graph-tools.ts registers twining_add_entity |
| GRPH-02 | Agent can add relationships between entities | GraphStore.addRelation() with entity lookup by ID or name; graph-tools.ts registers twining_add_relation |
| GRPH-03 | Agent can find connected entities with configurable depth | GraphEngine.neighbors() using BFS with depth limit (max 3); graph-tools.ts registers twining_neighbors |
| GRPH-04 | Agent can search entities by name or properties | GraphEngine.query() with substring matching on name and property values; graph-tools.ts registers twining_graph_query |
| DCSN-03 | Agent can trace decision dependency chain upstream/downstream | DecisionEngine.trace() walks depends_on (upstream) and reverse-depends_on (downstream) |
| DCSN-04 | Agent can flag decision for reconsideration | DecisionEngine.reconsider() sets status to provisional, posts warning to blackboard |
| DCSN-05 | Human can override a decision with reason | DecisionEngine.override() sets status to overridden, records overridden_by and reason, posts blackboard entry |
| DCSN-07 | Conflict detection on new decisions in same scope | Enhanced DecisionEngine.decide() checks same domain+scope for active decisions, marks new as provisional if conflict |
| LIFE-01 | Agent can archive old blackboard entries | Archiver engine moves entries before a timestamp from blackboard.jsonl to archive/{date}-blackboard.jsonl |
| LIFE-02 | Archive generates summary finding | Archiver creates a concatenated summary from archived entry summaries, posts as finding |
| LIFE-03 | Decision entries never archived | Archiver filters out entry_type==="decision" from archive candidates |
| LIFE-04 | Agent can check health/status | Enhanced twining_status with real graph counts, actionable warnings, needs_archiving logic |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| proper-lockfile | ^4.1.2 | Advisory file locking for concurrent writes | Already in use; all new stores follow same locking pattern |
| ulid | ^3.0.2 | Temporally sortable unique IDs | Already in use; all new entities/relations get ULIDs |
| zod | ^3.25.0 | Input validation for MCP tool schemas | Already in use; all new tools follow same schema pattern |
| @modelcontextprotocol/sdk | ^1.26.0 | MCP server and tool registration | Already in use; registerTool pattern established |

### Supporting
No new libraries needed. All Phase 3 features are implementable with existing dependencies.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| JSON array files for graph | JSONL for graph | JSON arrays allow random access by index and full replacement; JSONL is better for append-only. Graph needs full rewrites on entity updates (upsert), so JSON arrays are correct per spec |
| BFS for neighbor traversal | Recursive DFS | BFS naturally gives shortest-path neighbors at each depth level, which is more intuitive for "depth 1, 2, 3" semantics |
| Template-based archive summary | LLM-based summary | No LLM available in server process; template concatenation is deterministic and fast |

**Installation:**
```bash
# No new packages needed
```

## Architecture Patterns

### Recommended Project Structure (additions)
```
src/
  storage/
    graph-store.ts        # NEW: Knowledge graph CRUD (entities.json, relations.json)
  engine/
    graph.ts              # NEW: Graph traversal, query, neighbor search
    archiver.ts           # NEW: Archive + summarization logic
    decisions.ts          # EXTEND: add trace(), reconsider(), override(), conflict detection
  tools/
    graph-tools.ts        # NEW: MCP handlers for graph operations
    decision-tools.ts     # EXTEND: add twining_trace, twining_reconsider, twining_override
    lifecycle-tools.ts    # EXTEND: add twining_archive, enhance twining_status
  server.ts               # EXTEND: wire GraphStore, GraphEngine, Archiver
  engine/context-assembler.ts  # EXTEND: populate related_entities from graph
test/
  graph-store.test.ts     # NEW
  graph-engine.test.ts    # NEW
  archiver.test.ts        # NEW
  decision-engine.test.ts # EXTEND: trace, reconsider, override, conflict tests
  lifecycle-tools.test.ts # NEW or EXTEND
```

### Pattern 1: Storage Layer — GraphStore
**What:** A class following the established BlackboardStore/DecisionStore pattern. Reads/writes `graph/entities.json` and `graph/relations.json` using existing `readJSON`/`writeJSON` from `file-store.ts`.
**When to use:** All graph entity and relation CRUD.
**Key design:** The spec says "If entity with same name+type exists, updates it" for `twining_add_entity`. This means the store implements upsert semantics: load array, find by name+type, update if found or push if not, then writeJSON the full array.

```typescript
// Pattern: follows DecisionStore conventions
export class GraphStore {
  private readonly entitiesPath: string;
  private readonly relationsPath: string;

  constructor(twiningDir: string) {
    this.entitiesPath = path.join(twiningDir, "graph", "entities.json");
    this.relationsPath = path.join(twiningDir, "graph", "relations.json");
  }

  async addEntity(input: Omit<Entity, "id" | "created_at" | "updated_at">): Promise<Entity> {
    // Read, upsert, write pattern with locking
  }

  async addRelation(input: { source: string; target: string; type: string; properties?: Record<string, string> }): Promise<Relation> {
    // Resolve source/target by ID or name, then append
  }

  async getEntities(): Promise<Entity[]> { /* readJSON */ }
  async getRelations(): Promise<Relation[]> { /* readJSON */ }
  async getEntityById(id: string): Promise<Entity | null> { /* ... */ }
  async getEntityByName(name: string, type?: string): Promise<Entity | null> { /* ... */ }
}
```

### Pattern 2: Engine Layer — GraphEngine (BFS Traversal)
**What:** Business logic for graph operations: neighbor traversal with BFS, entity query with name/property matching.
**When to use:** Behind the twining_neighbors and twining_graph_query tools.
**Key design:** BFS with depth limit. Build an adjacency list from relations array, then traverse layer by layer. Max depth is 3 per spec.

```typescript
// BFS neighbor traversal
async neighbors(entityIdOrName: string, depth: number, relationTypes?: string[]): Promise<{
  center: Entity;
  neighbors: { entity: Entity; relation: string; direction: "outgoing" | "incoming" }[];
}> {
  const entities = await this.graphStore.getEntities();
  const relations = await this.graphStore.getRelations();

  // Resolve center entity (by ID or name)
  // Build adjacency: Map<entityId, { target: entityId, relation: Relation, direction }[]>
  // BFS from center, collecting neighbors up to depth
  // Return unique neighbors with their relation info
}
```

### Pattern 3: Decision Lifecycle Extensions
**What:** Three new methods on DecisionEngine plus enhanced decide() for conflict detection.
**When to use:** trace(), reconsider(), override() methods, and conflict checking in decide().
**Key design:**

**trace()** — Walk `depends_on` array (upstream) and scan all decisions whose `depends_on` includes the target (downstream). Uses the decision index for fast ID-based lookups.

**reconsider()** — Load decision, set status to "provisional" if currently "active", post a "warning" to blackboard with the new_context.

**override()** — Load decision, set status to "overridden", record overridden_by and override_reason, post blackboard entry.

**conflict detection in decide()** — Before creating the new decision, scan the index for existing active decisions with same domain AND overlapping scope. If found, mark the new decision as "provisional" and post a "warning" entry. Return conflict info in the response.

### Pattern 4: Archiver Engine
**What:** Moves old blackboard entries to archive files, generates summary, rebuilds embedding index.
**When to use:** Behind the twining_archive tool and potentially auto-triggered.
**Key design:**

```typescript
export class Archiver {
  constructor(
    private readonly twiningDir: string,
    private readonly blackboardStore: BlackboardStore,
    private readonly blackboardEngine: BlackboardEngine,
    private readonly indexManager: IndexManager | null,
  ) {}

  async archive(options: {
    before?: string;
    keep_decisions?: boolean;
    summarize?: boolean;
  }): Promise<{ archived_count: number; archive_file: string; summary?: string }> {
    // 1. Read all entries from blackboard.jsonl
    // 2. Partition into keep vs archive based on timestamp and type
    // 3. Always keep decision entries in active (keep_decisions defaults true)
    // 4. Write archived entries to archive/{date}-blackboard.jsonl
    // 5. Rewrite blackboard.jsonl with only kept entries
    // 6. If summarize, build summary string and post as finding
    // 7. Remove archived entry embeddings from index
    // 8. Return results
  }
}
```

**Critical:** This requires a new `writeJSONL` function in `file-store.ts` that overwrites (not appends) a JSONL file, since we need to rewrite `blackboard.jsonl` with only the kept entries.

### Pattern 5: Enhanced Status
**What:** Upgrade twining_status to include real graph counts and actionable warnings.
**When to use:** The existing lifecycle-tools.ts handler.
**Key design:** Add graph entity/relation counts from GraphStore, include warnings about stale provisionals and archiving threshold.

### Anti-Patterns to Avoid
- **Direct fs calls from engine/tools:** All I/O must go through storage layer (file-store.ts, GraphStore, BlackboardStore, etc.)
- **Throwing from tool handlers:** Always catch and return via `toolError()`. TwiningError is for engine->tool communication.
- **Blocking ONNX operations:** Embedding cleanup during archive must be best-effort; never let embedding failure block the archive.
- **Unbounded graph traversal:** Always enforce max depth of 3 in neighbors to prevent pathological cases.
- **Full file reads for every status check:** Graph entity/relation counts should read from the JSON files directly, not deserialize into full objects if only counting.

## Discretion Recommendations

Based on analysis of the design spec, existing code patterns, and practical considerations, here are recommendations for all Claude's Discretion items:

### Auto-population scope
**Recommendation:** Decisions-only auto-create graph entities. When `twining_decide` is called with `affected_files` and `affected_symbols`, auto-create "file" and "function"/"class" entities with "decided_by" relations. Findings do NOT auto-create entities.
**Rationale:** Decisions have structured `affected_files`/`affected_symbols` fields that map cleanly to entities. Findings have unstructured text; auto-extracting entity names from free text is unreliable without NLP. Keep it simple and reliable.

### Entity deduplication
**Recommendation:** Merge (upsert) — same name+type updates the existing entity's properties and `updated_at`.
**Rationale:** The spec explicitly says "If entity with same name+type exists, updates it" in the `twining_add_entity` side effects. This is already decided by the spec.

### Relationship inference
**Recommendation:** Keep relations explicit-only. Do not auto-create 'related_to' relations from shared scope.
**Rationale:** Auto-inference from shared scope would create noisy, low-value relationships (every file in `src/auth/` would be "related_to" every other file there). Explicit relations from agents are higher signal. The graph is more useful when it's intentionally curated.

### Graph search approach
**Recommendation:** Substring matching on entity name and property values for `twining_graph_query`. No semantic search.
**Rationale:** Entity names are short identifiers (file paths, class names, module names), not natural language. Substring/case-insensitive matching is more predictable and useful than semantic search for code identifiers. "auth" matching "AuthMiddleware" is more useful than embedding similarity for these items. This also avoids dependency on the embedding layer for graph operations.

### Conflict detection strictness
**Recommendation:** Same domain AND scope prefix overlap (either scope is a prefix of the other). Not exact scope match only.
**Rationale:** A decision scoped to `src/auth/` should conflict with a decision scoped to `src/auth/jwt.ts` in the same domain. Exact match would miss this obvious overlap. This matches the existing `getByScope()` logic in `DecisionStore` which already uses prefix matching.

### Reconsideration cascade
**Recommendation:** Do NOT cascade to downstream dependents. Only flag the specific decision as provisional. Log a warning that mentions dependent decisions exist.
**Rationale:** Cascading creates unpredictable side effects — a single reconsideration could flip dozens of decisions to provisional. Better to warn about downstream impacts and let the agent/human decide what to reconsider. The warning message should list downstream decision IDs so the information is available.

### Override flow
**Recommendation:** YES, auto-create a replacement decision when `new_decision` text is provided. If `new_decision` is given, call `decide()` with minimal fields (domain/scope from the old decision, summary from `new_decision`, context = override reason, rationale = override reason, `supersedes` = overridden decision ID). If `new_decision` is not provided, just mark as overridden without replacement.
**Rationale:** This makes the override flow complete — a human can say "No, do this instead" in one call rather than requiring override + separate decide. The `supersedes` field on the new decision maintains the chain.

### Summarization method
**Recommendation:** Hybrid template + concatenation. Group archived entries by entry_type, then concatenate summaries within each group, capped at a reasonable length. Template: "Archive summary: {count} entries archived. Decisions: kept. Findings: {top N finding summaries}. Warnings: {top N warning summaries}. Other: {count remaining}."
**Rationale:** Pure concatenation produces an unusable wall of text. Grouping by type and truncating gives a scannable summary. The spec suggests this approach: "concatenate summaries of archived entries and post a single finding entry."

### Archive triggers
**Recommendation:** Implement manual invocation and threshold-based auto-detection only. The threshold check goes in `twining_status` (report `needs_archiving: true`) and the archive tool itself. Do NOT implement commit hook or context switch triggers in Phase 3.
**Rationale:** Commit hooks require git integration (Phase 4 territory). Context switch detection is poorly defined. Manual + threshold covers the core need. The `twining_archive` tool is always available for manual use; `twining_status` warns when archiving is needed. Agents or humans can call archive when they see the warning.

### Archive searchability
**Recommendation:** Remove archived entries from the embedding index.
**Rationale:** The whole point of archiving is to reduce the active working set. Keeping archived entries in the embedding index means they still appear in semantic search results and context assembly, defeating the purpose. If someone needs archived data, they can read the archive files directly.

### Protected entry types
**Recommendation:** Only "decision" entries are protected (never archived). All other types can be archived.
**Rationale:** The spec is explicit: "Decision entries are never archived (permanent record)." No other entry type has this protection in the spec. This is the simplest and most predictable rule.

### Status depth
**Recommendation:** YES, include actionable warnings beyond basic counts. Specifically:
- Stale provisional decisions (provisional for >7 days)
- Unanswered questions (questions with no answer entry referencing them, older than 24 hours)
- Archiving needed/approaching threshold
- Orphan entities (entities with no relations) count
**Rationale:** Status is most useful when it surfaces things that need attention. Bare counts ("5 decisions") don't tell the agent what to do. "3 provisional decisions older than 7 days need resolution" is actionable.

### Archive threshold logic
**Recommendation:** Direct config value (`max_blackboard_entries_before_archive: 500`). Report `needs_archiving: true` when count >= threshold. No percentage-based early warning.
**Rationale:** The config already defines this value. The agent sees `needs_archiving: true` and can call `twining_archive`. Adding early warnings (80% of threshold) adds complexity without clear benefit — if the agent checks status regularly, it will catch the threshold.

### Graph health in status
**Recommendation:** Include entity count, relation count, and disconnected entity count. Skip graph density.
**Rationale:** Entity/relation counts are trivially computed by reading the JSON arrays. Disconnected entities (entities with zero relations) are a useful signal that the graph is incomplete. Graph density is a metric that requires context to interpret and adds no actionable value.

### Status summary string
**Recommendation:** YES, include a human-readable summary string alongside structured data.
**Rationale:** Agents parse structured data, but including a readable summary makes the tool output immediately useful without post-processing. Example: "Healthy. 42 blackboard entries, 8 active decisions, 15 graph entities. 2 provisional decisions need review."

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File locking | Custom mutex/semaphore | `proper-lockfile` (already in deps) | Race conditions from concurrent agent access are subtle; advisory locks handle it |
| ID generation | Custom timestamp+random | `ulid` (already in deps) | ULIDs are temporally sortable and proven unique across concurrent processes |
| JSON schema validation | Manual if/else checking | `zod` (already in deps) | MCP SDK registerTool expects Zod schemas; consistent with existing tools |
| Graph database | In-memory adjacency with custom persistence | JSON file-backed arrays | The spec mandates file-native storage; at <10k entities, full array read+filter is fast enough |

**Key insight:** Phase 3 adds no new dependencies. Every pattern needed is already established in the codebase. The risk is not "what library to use" but "correctly implementing graph traversal and state transitions without breaking existing behavior."

## Common Pitfalls

### Pitfall 1: Circular Dependencies in Decision Trace
**What goes wrong:** A decision chain A -> B -> C -> A causes infinite loop in trace().
**Why it happens:** Decisions can have arbitrary `depends_on` arrays. A human could create a cycle.
**How to avoid:** Use a visited set during BFS/DFS traversal. Stop traversing when revisiting a node.
**Warning signs:** Tests should include a cycle scenario.

### Pitfall 2: Race Condition on Graph Upsert
**What goes wrong:** Two concurrent agents add the same entity (name+type). Both read the array, both don't find it, both append, resulting in duplicates.
**Why it happens:** Read-check-write is not atomic without locking.
**How to avoid:** Use `proper-lockfile` on `entities.json` for the entire read-modify-write cycle, same as DecisionStore does for index.json.
**Warning signs:** Duplicate entities with same name+type appearing in tests with concurrent writes.

### Pitfall 3: Archive Rewrite Data Loss
**What goes wrong:** Archive reads blackboard.jsonl, new entries arrive between read and rewrite, new entries are lost.
**Why it happens:** Read + filter + rewrite is not atomic with append-only writers.
**How to avoid:** Lock `blackboard.jsonl` for the entire archive operation (read -> partition -> write archive -> rewrite active). The existing `proper-lockfile` pattern handles this, but the lock must be held for the full operation, not just individual reads/writes.
**Warning signs:** "Missing entry" errors after archive in concurrent tests.

### Pitfall 4: Entity Resolution Ambiguity in twining_add_relation
**What goes wrong:** `source: "auth"` could match multiple entities of different types.
**Why it happens:** The spec allows entity resolution by name, but names are not unique across types.
**How to avoid:** First try exact ID match, then try name match. If multiple entities match by name, require the caller to use the entity ID instead. Return an error listing ambiguous matches.
**Warning signs:** Relations pointing to wrong entities.

### Pitfall 5: Conflict Detection False Positives
**What goes wrong:** Every decision in `src/auth/` is flagged as conflicting with every other decision in `src/auth/`.
**Why it happens:** Scope overlap alone isn't enough — decisions in the same scope but different domains (e.g., "testing" vs "architecture") aren't conflicts.
**How to avoid:** Require BOTH same domain AND overlapping scope for conflict flagging. Additionally, only check against "active" decisions (not provisional, superseded, or overridden).
**Warning signs:** Status shows excessive provisional decisions.

### Pitfall 6: Archive Summary Explosion
**What goes wrong:** Summary finding posted to blackboard is 10,000+ characters for a large archive.
**Why it happens:** Concatenating 500 entry summaries without truncation.
**How to avoid:** Cap the summary to a reasonable size (e.g., 2000 chars). Group by type, show counts, include only top N summaries per type.
**Warning signs:** Blackboard entry summary exceeds 200-char limit, or detail field is unwieldy.

## Code Examples

### Graph Store Upsert Pattern
```typescript
// Source: follows DecisionStore.create() pattern from src/storage/decision-store.ts
async addEntity(input: { name: string; type: Entity["type"]; properties?: Record<string, string> }): Promise<Entity> {
  const filePath = this.entitiesPath;

  // Ensure file exists for locking
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([]));
  }

  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    const entities = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Entity[];
    const existing = entities.find(e => e.name === input.name && e.type === input.type);

    if (existing) {
      // Upsert: update properties and timestamp
      existing.properties = { ...existing.properties, ...input.properties };
      existing.updated_at = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(entities, null, 2));
      return existing;
    }

    // New entity
    const entity: Entity = {
      id: generateId(),
      name: input.name,
      type: input.type,
      properties: input.properties ?? {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    entities.push(entity);
    fs.writeFileSync(filePath, JSON.stringify(entities, null, 2));
    return entity;
  } finally {
    await release();
  }
}
```

### BFS Neighbor Traversal
```typescript
// Source: standard BFS adapted for bidirectional graph with depth limit
async neighbors(
  entityIdOrName: string,
  depth: number = 1,
  relationTypes?: string[],
): Promise<{ center: Entity; neighbors: NeighborResult[] }> {
  const entities = await this.graphStore.getEntities();
  const relations = await this.graphStore.getRelations();

  // Resolve center entity
  const center = entities.find(e => e.id === entityIdOrName)
    ?? entities.find(e => e.name === entityIdOrName);
  if (!center) throw new TwiningError(`Entity not found: ${entityIdOrName}`, "NOT_FOUND");

  // Build adjacency list (both directions)
  const adj = new Map<string, { targetId: string; relation: Relation; direction: "outgoing" | "incoming" }[]>();
  for (const rel of relations) {
    if (relationTypes && !relationTypes.includes(rel.type)) continue;

    if (!adj.has(rel.source)) adj.set(rel.source, []);
    adj.get(rel.source)!.push({ targetId: rel.target, relation: rel, direction: "outgoing" });

    if (!adj.has(rel.target)) adj.set(rel.target, []);
    adj.get(rel.target)!.push({ targetId: rel.source, relation: rel, direction: "incoming" });
  }

  // BFS with depth limit
  const visited = new Set<string>([center.id]);
  const result: NeighborResult[] = [];
  let frontier = [center.id];

  for (let d = 0; d < Math.min(depth, 3); d++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      for (const edge of adj.get(nodeId) ?? []) {
        if (!visited.has(edge.targetId)) {
          visited.add(edge.targetId);
          nextFrontier.push(edge.targetId);
          const entity = entities.find(e => e.id === edge.targetId);
          if (entity) {
            result.push({
              entity,
              relation: edge.relation.type,
              direction: edge.direction,
            });
          }
        }
      }
    }
    frontier = nextFrontier;
  }

  return { center, neighbors: result };
}
```

### Decision Trace (Upstream + Downstream)
```typescript
// Source: follows depends_on chain, no new deps needed
async trace(
  decisionId: string,
  direction: "upstream" | "downstream" | "both" = "both",
): Promise<{ chain: TraceEntry[] }> {
  const index = await this.decisionStore.getIndex();
  const chain = new Map<string, TraceEntry>();
  const visited = new Set<string>();

  // Build reverse dependency map for downstream
  const dependents = new Map<string, string[]>();
  for (const entry of index) {
    const decision = await this.decisionStore.get(entry.id);
    if (decision) {
      for (const depId of decision.depends_on) {
        if (!dependents.has(depId)) dependents.set(depId, []);
        dependents.get(depId)!.push(decision.id);
      }
    }
  }

  // BFS upstream (follow depends_on)
  if (direction === "upstream" || direction === "both") {
    const queue = [decisionId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const decision = await this.decisionStore.get(id);
      if (!decision) continue;
      chain.set(id, {
        id, summary: decision.summary,
        depends_on: decision.depends_on,
        dependents: dependents.get(id) ?? [],
        status: decision.status,
      });
      for (const depId of decision.depends_on) {
        if (!visited.has(depId)) queue.push(depId);
      }
    }
  }

  // BFS downstream (follow reverse dependency map)
  if (direction === "downstream" || direction === "both") {
    visited.clear();
    visited.add(decisionId); // Already added in upstream pass if both
    const queue = [decisionId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id) && id !== decisionId) continue;
      visited.add(id);
      const decision = await this.decisionStore.get(id);
      if (!decision) continue;
      if (!chain.has(id)) {
        chain.set(id, {
          id, summary: decision.summary,
          depends_on: decision.depends_on,
          dependents: dependents.get(id) ?? [],
          status: decision.status,
        });
      }
      for (const depId of dependents.get(id) ?? []) {
        if (!visited.has(depId)) queue.push(depId);
      }
    }
  }

  return { chain: Array.from(chain.values()) };
}
```

### Conflict Detection in decide()
```typescript
// Source: spec section 7.1 + user decision (provisional, not blocking)
// Insert into DecisionEngine.decide() BEFORE creating the new decision
async detectConflict(domain: string, scope: string, summary: string): Promise<{
  hasConflict: boolean;
  conflictingDecisions: { id: string; summary: string }[];
}> {
  const index = await this.decisionStore.getIndex();
  const conflicts = index.filter(entry =>
    entry.status === "active" &&
    entry.domain === domain &&
    (entry.scope.startsWith(scope) || scope.startsWith(entry.scope)) &&
    entry.summary !== summary  // Don't conflict with itself on re-creation
  );

  return {
    hasConflict: conflicts.length > 0,
    conflictingDecisions: conflicts.map(c => ({ id: c.id, summary: c.summary })),
  };
}
```

### Archive Flow
```typescript
// Source: spec section 6.2
async archive(options: { before?: string; keep_decisions?: boolean; summarize?: boolean }): Promise<ArchiveResult> {
  const keepDecisions = options.keep_decisions ?? true;
  const doSummarize = options.summarize ?? true;

  // Read all entries
  const allEntries = await readJSONL<BlackboardEntry>(this.blackboardPath);

  // Partition
  const cutoff = options.before ?? new Date().toISOString();
  const toArchive: BlackboardEntry[] = [];
  const toKeep: BlackboardEntry[] = [];

  for (const entry of allEntries) {
    if (entry.timestamp < cutoff && !(keepDecisions && entry.entry_type === "decision")) {
      toArchive.push(entry);
    } else {
      toKeep.push(entry);
    }
  }

  if (toArchive.length === 0) return { archived_count: 0, archive_file: "", summary: undefined };

  // Write archive file
  const date = new Date().toISOString().slice(0, 10);
  const archiveFile = path.join(this.archiveDir, `${date}-blackboard.jsonl`);
  // Append to existing archive file for same date
  for (const entry of toArchive) {
    await appendJSONL(archiveFile, entry);
  }

  // Rewrite active blackboard (requires lock held for entire operation)
  await writeJSONL(this.blackboardPath, toKeep);

  // Remove archived embeddings
  if (this.indexManager) {
    try {
      await this.indexManager.removeEntries("blackboard", toArchive.map(e => e.id));
    } catch { /* best effort */ }
  }

  // Generate summary
  let summary: string | undefined;
  if (doSummarize && toArchive.length > 0) {
    summary = this.buildSummary(toArchive);
    await this.blackboardEngine.post({
      entry_type: "finding",
      summary: `Archive: ${toArchive.length} entries archived`,
      detail: summary,
      tags: ["archive"],
      scope: "project",
    });
  }

  return { archived_count: toArchive.length, archive_file: archiveFile, summary };
}
```

### File Store Extension — writeJSONL
```typescript
// New function needed in file-store.ts for archive rewrite
export async function writeJSONL(filePath: string, data: unknown[]): Promise<void> {
  if (!fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, "");
  }
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    const content = data.map(item => JSON.stringify(item)).join("\n") + (data.length > 0 ? "\n" : "");
    fs.writeFileSync(filePath, content);
  } finally {
    await release();
  }
}
```

## Implementation Dependencies and Ordering

### Build Order (respects existing bottom-up convention from CLAUDE.md)

**Wave 1: Storage**
1. `src/storage/file-store.ts` — Add `writeJSONL` function
2. `src/storage/graph-store.ts` — New file: GraphStore class

**Wave 2: Engine**
3. `src/engine/graph.ts` — New file: GraphEngine class (neighbors, query)
4. `src/engine/archiver.ts` — New file: Archiver class
5. `src/engine/decisions.ts` — Extend: add trace(), reconsider(), override(), conflict detection in decide()

**Wave 3: Tools + Wiring**
6. `src/tools/graph-tools.ts` — New file: register graph MCP tools
7. `src/tools/decision-tools.ts` — Extend: register trace, reconsider, override tools
8. `src/tools/lifecycle-tools.ts` — Extend: register archive tool, enhance status
9. `src/server.ts` — Wire GraphStore, GraphEngine, Archiver into server creation
10. `src/engine/context-assembler.ts` — Populate `related_entities` from GraphEngine

### Cross-Module Dependencies
```
graph-store.ts ← graph.ts ← graph-tools.ts
                          ← context-assembler.ts (related_entities)
                          ← server.ts

file-store.ts (writeJSONL) ← archiver.ts ← lifecycle-tools.ts
blackboard-store.ts ←────────────────────── archiver.ts
blackboard-engine.ts ←───────────────────── archiver.ts (post summary)
index-manager.ts ←───────────────────────── archiver.ts (removeEntries)

decision-store.ts ← decisions.ts (trace/reconsider/override/conflict)
                  ← decision-tools.ts
blackboard-engine.ts ← decisions.ts (post warnings for conflicts/reconsider)
```

## Wiring Changes in server.ts

The existing `createServer()` needs these additions:

```typescript
// New imports
import { GraphStore } from "./storage/graph-store.js";
import { GraphEngine } from "./engine/graph.js";
import { Archiver } from "./engine/archiver.js";
import { registerGraphTools } from "./tools/graph-tools.js";

// In createServer():
const graphStore = new GraphStore(twiningDir);
const graphEngine = new GraphEngine(graphStore);
const archiver = new Archiver(twiningDir, blackboardStore, blackboardEngine, indexManager);

// Update contextAssembler to accept graphEngine
const contextAssembler = new ContextAssembler(
  blackboardStore, decisionStore, searchEngine, config, graphEngine  // NEW param
);

// Register new tools
registerGraphTools(server, graphEngine);
// Update existing registrations to pass new dependencies:
registerDecisionTools(server, decisionEngine);  // DecisionEngine needs new methods
registerLifecycleTools(server, twiningDir, blackboardStore, decisionStore, graphStore, archiver);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Graph not implemented | Phase 3 adds full graph CRUD + traversal | Phase 3 | Enables code entity tracking and relationship navigation |
| `related_entities: []` in context assembly | Populated from GraphEngine | Phase 3 | Context assembly now includes graph-derived relationships |
| `twining_status` has placeholder `graph_entities: 0` | Real counts from GraphStore | Phase 3 | Accurate health reporting |
| No archive capability | Full archive with summary generation | Phase 3 | Blackboard can be pruned while preserving decision history |
| Only decide/why for decisions | Full lifecycle: trace/reconsider/override/conflict | Phase 3 | Complete decision management |

## Open Questions

1. **Archive locking granularity**
   - What we know: Archive needs to read, partition, and rewrite blackboard.jsonl atomically. It also appends to archive files.
   - What's unclear: Whether to hold a single lock for the entire operation or use separate locks. A single lock on blackboard.jsonl for the full read-partition-rewrite is safest but could block concurrent posts for the duration.
   - Recommendation: Single lock on blackboard.jsonl for the full archive operation. Archive is infrequent and can tolerate brief blocking. The alternative (lock-free with a queue) is complex and unnecessary at this scale.

2. **Entity name collision across types**
   - What we know: An entity named "auth" could exist as both a "module" and a "concept". Upsert is name+type, so these are distinct. But `twining_add_relation` with `source: "auth"` is ambiguous.
   - What's unclear: How to handle name-only resolution when multiple types exist.
   - Recommendation: Try ID first, then name. If name matches multiple entities, return an error listing the matches with their types and IDs so the caller can retry with a specific ID. This is clear and avoids silent wrong-entity relations.

3. **Archive file naming for multiple archives per day**
   - What we know: Spec says `archive/{date}-blackboard.jsonl`. Multiple archives on the same day would write to the same file.
   - What's unclear: Whether to append to existing or use incrementing filenames.
   - Recommendation: Append to existing date-stamped file using `appendJSONL`. This keeps the file structure simple and is consistent with JSONL append patterns. Each archived entry already has its own timestamp for ordering.

## Sources

### Primary (HIGH confidence)
- TWINING-DESIGN-SPEC.md sections 3.3, 3.4, 4.4, 4.5, 6, 7 — Authoritative data models, tool signatures, and behavior
- Existing codebase (src/storage/, src/engine/, src/tools/) — Established patterns for storage, engine, and tool layers
- CONTEXT.md (03-CONTEXT.md) — User decisions and discretion areas

### Secondary (MEDIUM confidence)
- BFS traversal pattern — Standard graph algorithm, well-understood for bounded-depth neighbor search
- Template summarization — Standard approach for deterministic text generation without LLM

### Tertiary (LOW confidence)
- None — all findings are based on the spec and existing code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — No new dependencies; all patterns already proven in codebase
- Architecture: HIGH — Spec provides complete data models and tool signatures; existing code provides proven patterns
- Pitfalls: HIGH — Identified from direct code analysis of concurrency, traversal, and state management patterns

**Research date:** 2026-02-16
**Valid until:** 2026-03-16 (stable — internal codebase, no external dependency changes)
