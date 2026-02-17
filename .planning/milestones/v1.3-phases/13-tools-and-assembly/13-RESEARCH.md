# Phase 13: Tools and Assembly - Research

**Researched:** 2026-02-17
**Domain:** MCP tool registration for coordination features, context assembler + status integration
**Confidence:** HIGH

## Summary

Phase 13 is the integration layer that connects Phase 11-12's storage and engine code to the MCP tool surface and existing context assembly/status systems. It involves four distinct work areas: (1) a new `twining_agents` tool that lists registered agents with liveness, (2) extending `twining_status` to include agent counts, (3) extending `twining_assemble` to include handoff results in its output, and (4) extending context assembly to suggest available agents whose capabilities match the current task.

No new libraries or architectural patterns are needed. All four requirements compose existing infrastructure: `CoordinationEngine.discover()` provides agent ranking, `AgentStore.getAll()` provides the registry, `HandoffStore.list()` provides handoff index entries with scope filtering, and `computeLiveness` provides agent state. The work is predominantly wiring -- connecting Phase 12's engine to Phase 1-3's tool and assembler layers.

The key design challenge is HND-03 (handoff results in context assembly). The existing `ContextAssembler.assemble()` method does not depend on `HandoffStore` or `CoordinationEngine`. It will need new constructor dependencies and a new section in `AssembledContext` for handoff summaries. The other three requirements are straightforward additions to existing tool handlers.

**Primary recommendation:** Create a new `src/tools/coordination-tools.ts` for `twining_agents` (following the existing tool file pattern), extend `lifecycle-tools.ts` for the status agent counts, and modify `ContextAssembler` to accept `HandoffStore` and `AgentStore` as optional dependencies for handoff integration and agent suggestions. Extend the `AssembledContext` type with new fields.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DEL-04 | Agent can list all registered agents with capabilities and status via `twining_agents` | New tool in coordination-tools.ts calls AgentStore.getAll() + computeLiveness, returns agents with capabilities and liveness status |
| DEL-05 | `twining_status` shows registered and active agent counts | Extend lifecycle-tools.ts twining_status handler to read AgentStore.getAll() and computeLiveness, add registered_agents and active_agents counts to response |
| HND-03 | `twining_assemble` includes relevant handoff results in context output | Extend ContextAssembler to accept HandoffStore, query handoffs by scope, include summaries in AssembledContext output. Add `recent_handoffs` field to AssembledContext type |
| HND-06 | Context assembly suggests available agents with matching capabilities | Extend ContextAssembler to accept AgentStore (or CoordinationEngine), extract capability-relevant terms from task description, discover matching agents, add `suggested_agents` field to AssembledContext type |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^3.x | Schema validation for tool inputs | Already used by all tool registrations |
| vitest | ^4.0.18 | Test framework | Already configured, 419 tests passing |
| @modelcontextprotocol/sdk | existing | MCP server.registerTool() | Already used by all 6 tool files |

### Supporting
No new libraries needed. This phase composes existing infrastructure:
- `CoordinationEngine` (Phase 12) for discover() scoring
- `AgentStore` (Phase 11) for registry queries
- `HandoffStore` (Phase 11) for handoff listing with scope filtering
- `computeLiveness` (Phase 11) for agent liveness state
- `ContextAssembler` (Phase 2) for the assemble() method being extended
- `toolResult`/`toolError` helpers (Phase 1) for MCP response formatting

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New coordination-tools.ts file | Adding to lifecycle-tools.ts | Separate file follows existing pattern (one file per tool group); lifecycle-tools.ts already handles status + archive, coordination is a different domain |
| Adding HandoffStore directly to ContextAssembler | Adding CoordinationEngine to ContextAssembler | HandoffStore is sufficient -- only need `list()` with scope filter. Avoids circular dependencies (CoordinationEngine already depends on BlackboardEngine which ContextAssembler also uses) |
| Keyword extraction from task for capability matching | Simple pass-through of task as search text | Keyword extraction would be fragile and over-engineered; better to use existing tag-based matching via normalizeTags on the task words |

**Installation:**
No new packages needed.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── engine/
│   ├── context-assembler.ts  # MODIFY: Add HandoffStore + AgentStore dependencies, new output fields
│   └── coordination.ts       # EXISTS: CoordinationEngine (Phase 12)
├── storage/
│   ├── agent-store.ts         # EXISTS: AgentStore (Phase 11)
│   └── handoff-store.ts       # EXISTS: HandoffStore (Phase 11)
├── tools/
│   └── coordination-tools.ts  # NEW: twining_agents tool
│   └── lifecycle-tools.ts     # MODIFY: Add agent counts to twining_status
├── utils/
│   ├── types.ts               # MODIFY: Extend AssembledContext with handoff + agent suggestion fields
│   └── liveness.ts            # EXISTS: computeLiveness (Phase 11)
├── server.ts                  # MODIFY: Wire new stores/engine into tool registrations
test/
├── coordination-tools.test.ts # NEW: Tests for twining_agents tool
├── context-assembler.test.ts  # EXTEND: Tests for handoff + agent suggestion in assembly
└── tools.test.ts              # EXTEND: Tests for twining_status agent counts
```

### Pattern 1: New Tool File (follows blackboard-tools.ts pattern)

**What:** A `registerCoordinationTools` function that registers MCP tools for agent coordination.
**When to use:** When adding a new tool group that doesn't fit existing tool files.
**Why this pattern:** All 6 existing tool files follow the same pattern: export a `register*Tools(server, ...deps)` function, use `z` schemas for input validation, catch errors with `toolResult`/`toolError`.

```typescript
// Source: follows existing tool registration pattern (blackboard-tools.ts, lifecycle-tools.ts)
export function registerCoordinationTools(
  server: McpServer,
  agentStore: AgentStore,
  coordinationEngine: CoordinationEngine,
  config: TwiningConfig,
): void {
  server.registerTool(
    "twining_agents",
    {
      description: "List all registered agents with their capabilities and liveness status.",
      inputSchema: {
        include_gone: z.boolean().optional().describe("Include gone agents (default: true)"),
      },
    },
    async (args) => {
      try {
        const agents = await agentStore.getAll();
        const thresholds = config.agents?.liveness ?? DEFAULT_LIVENESS_THRESHOLDS;
        const now = new Date();
        const result = agents.map(agent => ({
          agent_id: agent.agent_id,
          capabilities: agent.capabilities,
          role: agent.role,
          description: agent.description,
          registered_at: agent.registered_at,
          last_active: agent.last_active,
          liveness: computeLiveness(agent.last_active, now, thresholds),
        }));
        // Filter if include_gone is explicitly false
        const filtered = args.include_gone === false
          ? result.filter(a => a.liveness !== "gone")
          : result;
        return toolResult({
          agents: filtered,
          total_registered: agents.length,
          active_count: result.filter(a => a.liveness === "active").length,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : "Unknown error", "INTERNAL_ERROR");
      }
    },
  );
}
```

### Pattern 2: Extending ContextAssembler with Optional Dependencies

**What:** Add `HandoffStore` and `AgentStore` as optional constructor parameters (like `graphEngine` and `planningBridge`).
**When to use:** When the assembler needs new data sources that may not always be available.
**Why this pattern:** The existing constructor already uses this pattern for `GraphEngine` (optional, defaults to null) and `PlanningBridge` (optional, defaults to null). Adding more optional dependencies follows the same convention.

```typescript
// Source: follows existing optional dependency pattern in context-assembler.ts
constructor(
  blackboardStore: BlackboardStore,
  decisionStore: DecisionStore,
  searchEngine: SearchEngine | null,
  config: TwiningConfig,
  graphEngine?: GraphEngine | null,
  planningBridge?: PlanningBridge | null,
  handoffStore?: HandoffStore | null,  // NEW
  agentStore?: AgentStore | null,       // NEW
)
```

### Pattern 3: Extending Status Response (non-breaking addition)

**What:** Add `registered_agents` and `active_agents` fields to the twining_status response object.
**When to use:** When adding new health metrics to the status tool.
**Why this pattern:** The status response is a flat object. Adding new numeric fields is non-breaking -- existing consumers ignore unknown fields. No need to change the return type signature.

### Anti-Patterns to Avoid
- **Circular dependency:** Do NOT inject CoordinationEngine into ContextAssembler. CoordinationEngine depends on BlackboardEngine; ContextAssembler should instead get AgentStore and HandoffStore directly.
- **Heavy agent matching in assembly:** Do NOT run full discover() in assemble(). Instead, get agents, compute liveness, and use simple tag-based relevance to avoid expensive scoring on every assembly call.
- **Breaking existing AssembledContext consumers:** Add new fields as optional to maintain backward compatibility. Dashboard API routes and tool handlers that consume AssembledContext should not break.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Agent liveness computation | Custom elapsed time logic in tool handler | `computeLiveness()` from `src/utils/liveness.ts` | Already tested with 8 unit tests; configurable thresholds |
| Tag normalization | Inline `.toLowerCase().trim()` | `normalizeTags()` from `src/utils/tags.ts` | Handles dedup, empties, and is tested with 6 tests |
| MCP response formatting | Raw `{ content: [...] }` objects | `toolResult()` / `toolError()` from `src/utils/errors.ts` | Consistent error structure with codes |
| Agent scoring | Custom matching in twining_agents | `scoreAgent()` from `src/engine/coordination.ts` | Pure function with 7 unit tests, uses weighted scoring |
| Handoff scope filtering | Custom scope matching logic | `HandoffStore.list({ scope })` | Already implements bidirectional prefix matching |

**Key insight:** Phase 13 is pure integration. Every algorithm needed (scoring, liveness, normalization, scope matching) already exists in Phases 11-12. The work is wiring, not algorithm design.

## Common Pitfalls

### Pitfall 1: Circular Dependency Between CoordinationEngine and ContextAssembler
**What goes wrong:** If ContextAssembler depends on CoordinationEngine and CoordinationEngine depends on BlackboardEngine (which ContextAssembler also depends on), you get a tangled dependency graph that's hard to test.
**Why it happens:** It's tempting to reuse CoordinationEngine.discover() for agent suggestions in assembly.
**How to avoid:** ContextAssembler should depend directly on AgentStore (for getAll + liveness computation) and HandoffStore (for list), NOT on CoordinationEngine. Both stores are leaf dependencies with no other engine deps.
**Warning signs:** Circular import errors, difficulty constructing test instances.

### Pitfall 2: Forgetting to Wire New Dependencies in server.ts
**What goes wrong:** New constructor parameters added to ContextAssembler but server.ts still passes the old argument list. TypeScript may or may not catch this depending on whether params are optional.
**Why it happens:** server.ts is the composition root where all dependencies are wired together.
**How to avoid:** After adding optional params, update server.ts to pass AgentStore and HandoffStore to ContextAssembler. Write integration-level tests.
**Warning signs:** Tests pass (mock deps) but runtime fails.

### Pitfall 3: Breaking Existing twining_status Tests
**What goes wrong:** Adding new fields to twining_status response without updating the test assertions, or changing the function signature of `registerLifecycleTools` to accept new dependencies.
**Why it happens:** The existing tests in `test/tools.test.ts` set up lifecycle tools with specific dependency arguments.
**How to avoid:** Update existing tests to include the new AgentStore dependency. Make AgentStore an optional parameter to maintain backward compatibility, or update all call sites.
**Warning signs:** `test/tools.test.ts` breaks with "too many arguments" or "missing argument" errors.

### Pitfall 4: Token Budget Exhaustion from Handoff Content
**What goes wrong:** Including full handoff records in assembled context blows the token budget, crowding out decisions and warnings.
**Why it happens:** HandoffRecord.results can contain detailed descriptions and artifacts.
**How to avoid:** Include only HandoffIndexEntry-level data (summary, source/target agent, status, scope) in assembled context. Use the lightweight JSONL index, not full JSON records. Cap the number of included handoffs (e.g., 5 most recent matching scope).
**Warning signs:** Assembled context has many handoffs but zero decisions.

### Pitfall 5: Over-Complex Agent Suggestion Algorithm
**What goes wrong:** Building a sophisticated NLP-based capability matcher when simple tag overlap is sufficient.
**Why it happens:** HND-06 says "suggest available agents with matching capabilities" which sounds like it needs smart matching.
**How to avoid:** Extract words from the task description, normalize them, and compare against agent capability tags using simple set intersection. Active agents with any tag overlap get suggested. This is lightweight and sufficient.
**Warning signs:** Spending more time on the suggestion algorithm than on the other three requirements combined.

## Code Examples

Verified patterns from the existing codebase:

### Tool Registration (from blackboard-tools.ts)
```typescript
// Pattern for all tool registrations in the project
server.registerTool(
  "tool_name",
  {
    description: "Tool description for Claude.",
    inputSchema: {
      param: z.string().describe("Parameter description"),
      optional_param: z.boolean().optional().describe("Optional parameter"),
    },
  },
  async (args) => {
    try {
      const result = await engine.method(args);
      return toolResult(result);
    } catch (e) {
      if (e instanceof TwiningError) {
        return toolError(e.message, e.code);
      }
      return toolError(
        e instanceof Error ? e.message : "Unknown error",
        "INTERNAL_ERROR",
      );
    }
  },
);
```

### Optional Constructor Dependency (from context-assembler.ts)
```typescript
// Existing pattern for optional engine dependencies
constructor(
  blackboardStore: BlackboardStore,
  decisionStore: DecisionStore,
  searchEngine: SearchEngine | null,
  config: TwiningConfig,
  graphEngine?: GraphEngine | null,      // Optional, defaults to null
  planningBridge?: PlanningBridge | null, // Optional, defaults to null
) {
  this.graphEngine = graphEngine ?? null;
  this.planningBridge = planningBridge ?? null;
}
```

### Lifecycle Tool Status (from lifecycle-tools.ts, line 31-152)
```typescript
// Pattern for extending status response — just add new fields to the result object
return toolResult({
  project,
  blackboard_entries,
  active_decisions,
  provisional_decisions,
  graph_entities,
  graph_relations,
  last_activity,
  needs_archiving,
  warnings,
  summary,
  // NEW fields would go here:
  // registered_agents: count,
  // active_agents: count,
});
```

### HandoffStore.list() Usage (from handoff-store.ts)
```typescript
// How to query handoffs by scope — already supports scope filtering
const handoffs = await handoffStore.list({
  scope: "src/auth/",   // Bidirectional prefix match
  limit: 5,             // Cap results
});
// Returns HandoffIndexEntry[] with: id, created_at, source_agent, target_agent, scope, summary, result_status, acknowledged
```

### Server.ts Wiring (from server.ts)
```typescript
// Pattern: create stores, create engines, register tools
const agentStore = new AgentStore(twiningDir);      // Phase 11
const handoffStore = new HandoffStore(twiningDir);   // Phase 11

// Wire into coordination engine
const coordinationEngine = new CoordinationEngine(
  agentStore, handoffStore, blackboardEngine,
  decisionStore, blackboardStore, config,
);

// Wire into context assembler (extend existing constructor call)
const contextAssembler = new ContextAssembler(
  blackboardStore, decisionStore, searchEngine, config,
  graphEngine, planningBridge,
  handoffStore,  // NEW
  agentStore,    // NEW
);

// Register new coordination tools
registerCoordinationTools(server, agentStore, coordinationEngine, config);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No agent awareness in context assembly | Handoff results + agent suggestions in assembly | Phase 13 (this phase) | Assembly becomes coordination-aware |
| Status shows only blackboard + decision + graph counts | Status also shows agent registry counts | Phase 13 (this phase) | Agents visible in health check |
| 22 MCP tools | 23 MCP tools (adding twining_agents) | Phase 13 (this phase) | New tool for agent listing |

**Deprecated/outdated:**
- Nothing deprecated. Phase 13 extends existing systems, doesn't replace them.

## Open Questions

1. **How many handoffs to include in assembled context?**
   - What we know: Token budget is typically 4000 tokens. HandoffIndexEntry is ~50 tokens per entry. 5 handoffs = ~250 tokens.
   - What's unclear: Whether 5 is the right cap, or if it should be configurable.
   - Recommendation: Cap at 5 most recent scope-matching handoffs. This is conservative and can be tuned later. Not worth making configurable in Phase 13.

2. **Should agent suggestions compete for token budget or be outside it?**
   - What we know: `planning_state` is included outside the token budget (line 326-353 of context-assembler.ts). Agent suggestions are metadata-like, small.
   - What's unclear: Whether suggestions should go through the scoring/budget system or be appended unconditionally.
   - Recommendation: Include agent suggestions outside the token budget (same as planning_state). They're small (agent_id + capabilities per agent), fixed-size, and always useful for coordination.

3. **What capability extraction strategy for HND-06?**
   - What we know: Agent capabilities are free-form strings like "testing", "auth", "frontend". Tasks are natural language like "Write tests for the auth module".
   - What's unclear: How sophisticated the extraction needs to be.
   - Recommendation: Split task description into normalized words, compare against agent capability tags using substring matching. If an agent has capability "testing" and the task contains "test" or "tests", that's a match. Simple, fast, good enough. Can improve later.

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `src/engine/coordination.ts` (335 lines) -- CoordinationEngine with discover, postDelegation, createHandoff, acknowledgeHandoff
- Codebase inspection: `src/engine/context-assembler.ts` (570 lines) -- ContextAssembler with assemble, summarize, whatChanged
- Codebase inspection: `src/tools/lifecycle-tools.ts` (191 lines) -- twining_status and twining_archive handlers
- Codebase inspection: `src/tools/blackboard-tools.ts` (167 lines) -- tool registration pattern reference
- Codebase inspection: `src/server.ts` (108 lines) -- composition root, dependency wiring
- Codebase inspection: `src/utils/types.ts` (359 lines) -- AssembledContext, SummarizeResult, AgentRecord, HandoffRecord types
- Phase 12 verification report: All 48 coordination engine tests pass, all 9 requirements satisfied
- Full test suite: 419/419 tests pass across 26 test files

### Secondary (MEDIUM confidence)
- Phase 11-12 research and plan files -- design decisions referenced as "prior decisions" in phase context
- REQUIREMENTS.md -- formal requirement definitions for DEL-04, DEL-05, HND-03, HND-06

### Tertiary (LOW confidence)
- None. All findings verified against codebase.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries, all dependencies already exist in project
- Architecture: HIGH -- all patterns (tool registration, optional deps, status extension) have precedents in codebase
- Pitfalls: HIGH -- identified from direct codebase analysis, not speculation
- Integration approach: HIGH -- verified types, function signatures, and wiring patterns in existing code

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (30 days -- stable internal codebase, no external API dependencies)
