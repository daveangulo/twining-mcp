# Phase 1: Foundation + Core Data - Context

**Gathered:** 2026-02-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Storage layer, blackboard, basic decisions, and MCP server wiring. Agents can post entries to a shared blackboard, record decisions with rationale, and query both — served as a working MCP server over stdio. Semantic search, context assembly, knowledge graph, and advanced decision lifecycle are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Tool response design
- Claude's discretion on verbosity — pick what makes sense per tool (minimal for writes, richer for reads)
- Claude's discretion on error detail level — make errors actionable where possible
- Claude's discretion on whether to include internal metadata (embedding_id etc.) — strip what's noisy, keep what's useful
- Claude's discretion on response size limits — use reasonable defaults, agents control via `limit` parameter

### Init behavior
- Silent auto-create: when `.twining/` doesn't exist, create it and proceed with no user interaction
- Config format: **YAML** (`config.yml`) as specified in the design spec
- Gitignore: as spec'd — `embeddings/*.index` and `archive/` only
- Claude's discretion on whether default config is minimal or full

### Concurrency model
- Claude's discretion on lock strategy (retry with backoff vs fail-fast), lock scope (per-file vs per-operation), stale lock handling, and corrupt data recovery
- The research flagged these as critical — use proper-lockfile with sensible defaults and ensure crash recovery works

### Scope conventions
- Scopes should leverage **Serena symbol names** when a tool like Serena is available, falling back to **file paths** otherwise
- Need rebuild capability if tools are added/removed (scope references may need updating)
- Claude's discretion on: prefix matching strictness, whether "project" is a special wildcard, and hierarchical cascading behavior

### Claude's Discretion
- Tool response verbosity and metadata inclusion per tool
- Error response detail level
- Config file completeness (minimal vs full defaults)
- All concurrency implementation details (lock strategy, stale handling, corruption recovery)
- Scope matching semantics (prefix rules, wildcard scopes, hierarchy)

</decisions>

<specifics>
## Specific Ideas

- Scopes should be designed with future tool integration in mind — if Serena or similar symbol-aware tools are available, use their symbol names as scopes. If not, file paths are the fallback. The system should support rebuilding scope references when the tooling environment changes.
- The design spec is authoritative for all data models, tool signatures, and behavior — follow it closely.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation-core-data*
*Context gathered: 2026-02-16*
