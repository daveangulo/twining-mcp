# Phase 11: Types and Storage - Context

**Gathered:** 2026-02-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Data models and storage layer for agent registry and handoff records. Agent records persist to `.twining/agents/registry.json`, handoff records persist to `.twining/handoffs/` as individual JSON files with a JSONL index. Liveness status computed from timestamps. Directories auto-created on first use. Coordination logic, MCP tools, and dashboard are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Agent identity
- Claude's Discretion: ID format (agent-provided string vs ULID vs hybrid)
- Claude's Discretion: Auto-register behavior on first tool call (what to capture)
- Claude's Discretion: Re-registration semantics (upsert vs immutable)
- Claude's Discretion: Additional metadata fields beyond requirements (agent_id, capabilities, role, description, timestamps)

### Capability tags
- Free-form strings (locked by REG-03 and out-of-scope decision on taxonomy)
- Claude's Discretion: Tag granularity model (coarse roles, fine-grained skills, or mixed)
- Claude's Discretion: Normalization rules (lowercase, trim, etc.)
- Claude's Discretion: Tag limits per agent
- No strong opinion on tag conventions — let it emerge from usage

### Liveness thresholds
- Three states: active/idle/gone (locked by REG-04)
- Claude's Discretion: Default thresholds for active→idle and idle→gone transitions
- Claude's Discretion: Whether thresholds are configurable or hardcoded
- Claude's Discretion: Cleanup strategy for gone agents (keep vs auto-prune)

### Handoff record shape
- IDs and summaries, not full context serialization (locked by out-of-scope decision)
- Claude's Discretion: Results structure (free-form vs structured with status)
- Claude's Discretion: Context snapshot scope (decisions+warnings only vs any blackboard entry type)
- Claude's Discretion: Whether handoffs have a scope field for codebase-area filtering
- Claude's Discretion: JSONL index design and query patterns

### Claude's Discretion
All four areas discussed were delegated entirely to Claude's judgment. The user trusts Claude to design data models that:
- Follow existing Twining patterns (blackboard, decisions, graph storage)
- Serve the query patterns needed by Phases 12-14
- Stay minimal — don't over-engineer for hypothetical needs
- Are consistent with the project's ULID/file-native/JSONL conventions

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. Key constraints come from REQUIREMENTS.md:
- REG-03: Capabilities are free-form strings (no taxonomy)
- Out of scope: heartbeat, capability ontology, auth, full context serialization, separate delegation queue
- STATE.md notes prior decisions: "Delegations are blackboard entries with structured metadata", "Liveness inferred from last_active timestamp", "Handoff records store IDs and summaries"

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 11-types-and-storage*
*Context gathered: 2026-02-17*
