# Twining MCP Server

## What This Is

Twining is an MCP server for Claude Code that provides a shared coordination layer between AI agents. It combines a blackboard-pattern shared state system, a first-class decision log with full lifecycle management, a selective context assembler with semantic search, a lightweight knowledge graph, and local ONNX embeddings — all backed by plain files (`.jsonl`/`.json`) that are git-trackable and human-inspectable. It integrates with the GSD planning workflow (bidirectional state sync), git history (decision-to-commit traceability), and Serena code intelligence (agent-mediated knowledge graph enrichment).

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
- ✓ GSD planning bridge — `.planning/` state feeds context assembly; decisions sync to planning docs — v1.1
- ✓ Git commit linking — bidirectional decision-to-commit tracking (twining_link_commit, twining_commits) — v1.1
- ✓ Serena enrichment workflow — CLAUDE.md instructions for agent-mediated code graph population — v1.1
- ✓ `twining_search_decisions` tool — find decisions by keyword/semantic search with filters — v1.1
- ✓ `twining_export` tool — dump Twining state as single markdown document with scope filtering — v1.1

### Active

(None — planning next milestone)

### Out of Scope

- Multi-agent registration and capability matching — future milestone
- Web dashboard — future milestone
- Learned relevance weights — future milestone
- Cross-repo Twining state — future milestone
- Decision impact analysis — future milestone
- Hook-based pending-posts/actions processing — deferred, CLAUDE.md workflows preferred over hook plumbing

## Context

- **Runtime:** Node.js >= 18, TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Embeddings:** `@huggingface/transformers` v3 with `all-MiniLM-L6-v2` (local ONNX, no API calls)
- **IDs:** ULID (temporally sortable)
- **Package:** `twining-mcp` on npm
- **Design spec:** `TWINING-DESIGN-SPEC.md` is the authoritative reference for all data models, tool signatures, and behavior
- **Build order:** utils → storage → engine → embeddings → tools → server/index (bottom-up)
- **Testing:** vitest with temp directories, 274 tests across 18 files
- **Current state:** v1.1 shipped — 22 MCP tools, ~5,204 LOC production + 5,400 LOC tests

## Constraints

- **Lazy embeddings**: ONNX model must be lazy-loaded and fall back gracefully to keyword search if unavailable. Server must never fail to start due to embedding issues.
- **File-native**: All state in `.twining/` directory — no external databases. JSONL for append-only streams, JSON for indexed data.
- **No direct fs from engine**: All file I/O goes through storage/ layer (exception: STATE.md sync uses direct fs since it's a GSD planning file, not Twining data).
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
| commit_hashes as string[] (not single hash) | A decision may link to multiple commits over time (initial impl + fixes) | ✓ Good — v1.1 |
| Index entries mirror commit_hashes | Fast commit-based lookups without loading full decision files | ✓ Good — v1.1 |
| PlanningBridge as dual output (metadata + scored finding) | Planning state always visible as metadata; also competes fairly for token budget as scored item | ✓ Good — v1.1 |
| Direct fs for STATE.md sync (not file-store) | STATE.md is a GSD planning file, not Twining data | ✓ Good — v1.1 |
| syncToPlanning is fire-and-forget | Never blocks or crashes decide(); wrapped in try/catch | ✓ Good — v1.1 |
| SearchEngine as optional constructor param | Loose coupling; DecisionEngine works without search, gains search when provided | ✓ Good — v1.1 |
| Index-level filtering before loading full files | Minimizes disk I/O for search across large decision sets | ✓ Good — v1.1 |
| Agent-mediated Serena workflow (CLAUDE.md) | No direct MCP-to-MCP coupling; agent orchestrates both tool sets | ✓ Good — v1.1 |

---
*Last updated: 2026-02-17 after v1.1 milestone*
