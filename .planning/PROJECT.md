# Twining MCP Server

## What This Is

Twining is an MCP server for Claude Code that provides a shared coordination layer between AI agents. It combines a blackboard-pattern shared state system, a first-class decision log with rationale tracking, a selective context assembler, a lightweight knowledge graph, and local semantic search — all backed by plain files (`.jsonl`/`.json`) that are git-trackable and human-inspectable.

## Core Value

Agents share *why* decisions were made, not just *what* was done — eliminating the information silos that degrade multi-agent coding workflows across context windows.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Blackboard system for shared state (post, read, query, recent)
- [ ] Decision tracker with full rationale, alternatives, and traceability (decide, why, trace, reconsider, override)
- [ ] Context assembler that builds tailored context packages per task (assemble, summarize, what_changed)
- [ ] Knowledge graph for entity and relation tracking (add_entity, add_relation, neighbors, graph_query)
- [ ] Local semantic search via ONNX embeddings with graceful fallback to keyword search
- [ ] Lifecycle management (archive, status)
- [ ] File-native storage — all state in `.twining/` as JSONL/JSON
- [ ] Auto-initialization of `.twining/` directory on first tool call
- [ ] Conflict detection for contradictory decisions in same scope
- [ ] Advisory file locking for concurrent agent access

### Out of Scope

- Multi-agent registration and capability matching — Phase 2
- Serena MCP integration — Phase 3
- GSD `.planning/` state synchronization — Phase 3
- Git commit linking — Phase 3
- Web dashboard — Phase 3
- Learned relevance weights — Phase 4
- Cross-repo Twining state — Phase 4
- Decision impact analysis — Phase 4

## Context

- **Runtime:** Node.js >= 18, TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Embeddings:** `onnxruntime-node` with `all-MiniLM-L6-v2` (local, no API calls)
- **IDs:** ULID (temporally sortable)
- **Package:** `twining-mcp` on npm
- **Design spec:** `TWINING-DESIGN-SPEC.md` is the authoritative reference for all data models, tool signatures, and behavior
- **Build order:** utils → storage → engine → embeddings → tools → server/index (bottom-up)
- **Testing:** vitest with temp directories, tests alongside implementation

## Constraints

- **Lazy embeddings**: ONNX model must be lazy-loaded and fall back gracefully to keyword search if unavailable. Server must never fail to start due to embedding issues.
- **File-native**: All state in `.twining/` directory — no external databases. JSONL for append-only streams, JSON for indexed data.
- **No direct fs from engine**: All file I/O goes through storage/ layer.
- **Structured errors**: Tool handlers return structured error responses, never throw.
- **ULID IDs**: All IDs are ULIDs for temporal sortability.
- **Token estimation**: 4 chars per token approximation for context budget management.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Blackboard pattern over pipeline | Agents self-select into work based on visible shared state; broadcasts needs rather than routing | — Pending |
| JSONL for blackboard, JSON for decisions/graph | Append-only stream for high-frequency writes; indexed files for random access | — Pending |
| ONNX local embeddings over API calls | Zero external dependencies, works offline, no API costs | — Pending |
| Cosine similarity brute-force search | Sufficient for <10k entries; optimize later if needed | — Pending |
| `proper-lockfile` for concurrent access | Advisory file locking prevents corruption from concurrent agent writes | — Pending |
| Human-in-the-loop conflict resolution | Flag conflicts for human review rather than auto-resolving | — Pending |

---
*Last updated: 2026-02-16 after initialization*
