# Twining MCP Server

## What This Is

Twining is an MCP server for Claude Code that provides a shared coordination layer between AI agents. It combines a blackboard-pattern shared state system, a first-class decision log with full lifecycle management, a selective context assembler with semantic search, a lightweight knowledge graph, and local ONNX embeddings — all backed by plain files (`.jsonl`/`.json`) that are git-trackable and human-inspectable.

## Core Value

Agents share *why* decisions were made, not just *what* was done — eliminating the information silos that degrade multi-agent coding workflows across context windows.

## Requirements

### Validated

- ✓ Blackboard system for shared state (post, read, query, recent) — v1
- ✓ Decision tracker with full rationale, alternatives, and traceability (decide, why, trace, reconsider, override) — v1
- ✓ Context assembler that builds tailored context packages per task (assemble, summarize, what_changed) — v1
- ✓ Knowledge graph for entity and relation tracking (add_entity, add_relation, neighbors, graph_query) — v1
- ✓ Local semantic search via ONNX embeddings with graceful fallback to keyword search — v1
- ✓ Lifecycle management (archive, status) — v1
- ✓ File-native storage — all state in `.twining/` as JSONL/JSON — v1
- ✓ Auto-initialization of `.twining/` directory on first tool call — v1
- ✓ Conflict detection for contradictory decisions in same scope — v1
- ✓ Advisory file locking for concurrent agent access — v1

### Active

(None yet — define in next milestone)

### Out of Scope

- Multi-agent registration and capability matching — future milestone
- Serena MCP integration — future milestone
- GSD `.planning/` state synchronization — future milestone
- Git commit linking — future milestone
- Web dashboard — future milestone
- Learned relevance weights — future milestone
- Cross-repo Twining state — future milestone
- Decision impact analysis — future milestone

## Context

- **Runtime:** Node.js >= 18, TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Embeddings:** `@huggingface/transformers` v3 with `all-MiniLM-L6-v2` (local ONNX, no API calls)
- **IDs:** ULID (temporally sortable)
- **Package:** `twining-mcp` on npm
- **Design spec:** `TWINING-DESIGN-SPEC.md` is the authoritative reference for all data models, tool signatures, and behavior
- **Build order:** utils → storage → engine → embeddings → tools → server/index (bottom-up)
- **Testing:** vitest with temp directories, 221 tests across 16 files
- **Current state:** v1 shipped — 18 MCP tools, ~3,936 LOC production + 4,145 LOC tests

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
| Blackboard pattern over pipeline | Agents self-select into work based on visible shared state; broadcasts needs rather than routing | ✓ Good — clean separation of concerns, scales to multiple consumers |
| JSONL for blackboard, JSON for decisions/graph | Append-only stream for high-frequency writes; indexed files for random access | ✓ Good — simple and reliable |
| ONNX local embeddings via @huggingface/transformers | Zero external dependencies, works offline, no API costs; transformers v3 handles tokenization+pooling | ✓ Good — lazy-load + permanent fallback works well |
| Cosine similarity brute-force search | Sufficient for <10k entries; optimize later if needed | ✓ Good — no perf issues observed |
| `proper-lockfile` for concurrent access | Advisory file locking prevents corruption from concurrent agent writes | ✓ Good — concurrency tests pass (3.5s) |
| Human-in-the-loop conflict resolution | Flag conflicts for human review rather than auto-resolving | ✓ Good — prefix-overlap scope detection works |
| Entity upsert by name+type pair | Prevents duplicate entities, merges properties on update | ✓ Good — v1 |
| BFS depth clamped to 3 | Prevents runaway traversals in dense graphs | ✓ Good — v1 |
| Weighted context scoring (0.3/0.4/0.2/0.1) | Recency, relevance, confidence, warning boost — balanced signals | ✓ Good — v1 |
| Permanent ONNX fallback once triggered | Avoids repeated expensive init failures; keyword search is adequate fallback | ✓ Good — v1 |

---
*Last updated: 2026-02-17 after v1 milestone*
