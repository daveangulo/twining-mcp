# Project Research Summary

**Project:** Twining MCP Server
**Domain:** Agent coordination and shared state management for multi-agent development workflows
**Researched:** 2026-02-16
**Confidence:** HIGH

## Executive Summary

Twining is an MCP server that coordinates multi-agent development workflows through a structured blackboard pattern with decision tracking and context assembly. The research validates the design spec's architectural choices and identifies critical implementation risks. The recommended approach uses file-native storage (JSONL/JSON) for git-trackability, local ONNX embeddings with graceful fallback to keyword search, and a layered architecture with strict dependency isolation. The core differentiators are structured decision records with dependency chains, token-budgeted context assembly, and a code-aware knowledge graph—features that set Twining apart from generic memory servers like MCP Memory or Memory Keeper.

The most critical risks center on concurrency (read-modify-write races, JSONL append corruption), embedding system reliability (onnxruntime-node installation failures), and context window bloat from tool responses. These are mitigated through proper-lockfile for all state mutations, lazy-loaded embeddings with comprehensive fallback, and strict token budget enforcement on every tool response. The build order follows bottom-up layering: utils → storage → engine → embeddings → tools → server, allowing each layer to be fully tested before the next is built.

The roadmap should prioritize the storage and blackboard foundations first (decision recording is the core thesis), then add semantic search and context assembly as the key differentiators, with the knowledge graph and lifecycle features as "complete the experience" capabilities. Phases 1-2 focus on critical path features; Phase 3+ adds polish and integrations.

## Key Findings

### Recommended Stack

The stack is prescribed by the design spec and validated as current and production-ready. Core framework is the official `@modelcontextprotocol/sdk` (v1.26+) with Zod v4 for schema validation, running on Node.js 18+ with TypeScript 5.9. Embeddings use `onnxruntime-node` (v1.24.1) with the all-MiniLM-L6-v2 ONNX model (384-dim, ~23MB). File locking via `proper-lockfile` (v4.1.2) handles concurrency. ULIDs provide temporally sortable IDs. Config parsing uses `js-yaml`. Testing with Vitest 4.

**Core technologies:**
- `@modelcontextprotocol/sdk` (v1.26+): MCP server framework with built-in tool registration and Zod validation
- `onnxruntime-node` (v1.24.1): Local ONNX inference for zero-API-call semantic search with graceful fallback
- `proper-lockfile` (v4.1.2): Advisory file locking using atomic mkdir strategy, works on all file systems
- `ulid` (v3.0.2): Temporally sortable IDs eliminating need for timestamp parsing
- `js-yaml` (v4.1.1): YAML config parsing (design spec prescribes YAML over JSON)

**Critical configuration changes needed:**
- Package.json must set `"type": "module"` (currently "commonjs") for ESM compatibility with MCP SDK
- tsconfig.json needs `"types": ["node"]` for Node.js API type information
- Exclude JSX options from tsconfig (not needed for server project)

**What NOT to use:**
- `@huggingface/transformers`: 48MB bloat, stale onnxruntime pin (1.21.0), unnecessary image processing deps
- `sqlite3` / `better-sqlite3`: Violates git-trackable file-native storage principle
- `tokenizers` npm: Native binary complexity for simple WordPiece use case
- `fastmcp`: Official SDK is sufficient and authoritative

### Expected Features

The competitive landscape shows 6+ MCP memory/coordination servers (Official Memory, Memory Keeper, Memory Service, memory-mcp, Agent-MCP, Claude-flow). Twining must match table stakes while offering unique value through structured decision tracking and context assembly.

**Must have (table stakes):**
- Persistent shared state (blackboard) with typed entries (need/offer/finding/decision/etc.)
- Read/write/query operations with filtering by type, scope, tags, time
- Decision recording with structured rationale (vs. flat text in competitors)
- Decision retrieval by scope (`twining_why` for "why was this file designed this way?")
- Semantic search (expected in 2026, all modern MCP servers have it)
- Keyword search fallback (ONNX can fail on some platforms, server must never refuse to start)
- Status/health check (standard for production MCP servers)
- Zero-config initialization (auto-create `.twining/` on first call)
- Structured error responses (never throw from tool handlers)
- File-native, git-trackable storage (differentiator that is also table stakes for developer audience)

**Should have (competitive advantage):**
- Structured decision records with alternatives/pros/cons/constraints (no competitor has this)
- Decision dependency chains (`twining_trace` following depends_on/supersedes)
- Decision lifecycle (reconsider, override with formal workflow)
- Conflict detection (contradictory decisions in same scope/domain)
- Context assembly with token budgeting (no other MCP server assembles context—they return raw search results)
- Typed entry taxonomy (10 types vs 5 in competitors)
- Code-aware knowledge graph (entities: module/function/class, relations: depends_on/implements/decided_by)
- Change tracking (`twining_what_changed` for handoff between agent sessions)
- Archiving with summarization (prevents unbounded growth)
- Scope-aware operations (prefix matching threads through all tools)
- Human override workflow (audit trail for human intervention)

**Defer (anti-features for Phase 1):**
- Agent registration/management (Claude Code already handles this via Task() and Agent Teams)
- Direct agent-to-agent messaging (violates blackboard pattern—agents coordinate through environment)
- Web dashboard (premature, file-native storage IS the dashboard via jq/cat/editor)
- Cloud sync (local-first, git is the sync mechanism)
- Emotional metadata/sentiment (irrelevant for code coordination)
- Automatic memory extraction from transcripts (requires LLM calls, unpredictable quality)
- SQLite (breaks git-trackability)
- Too many tools (>20 causes selection confusion—keep to ~17)
- Real-time heartbeats (agents are ephemeral in Claude Code)
- Consensus algorithms/CRDT (massive over-engineering for local MCP)

**Tool count target:** 17 tools across 5 groups (blackboard, decision, context, graph, lifecycle). Use parameters for filtering variants, not separate tools.

### Architecture Approach

Validated layered architecture with strict downward-only dependencies: tools → engine → storage → filesystem. Each layer is independently testable. The embedding system is lazy-loaded and completely isolated—it never blocks server startup.

**Major components:**

1. **Storage layer** (`src/storage/`): File I/O primitives with locking, JSONL append, JSON read-modify-write, domain stores for blackboard/decisions/graph
2. **Engine layer** (`src/engine/`): Business logic for blackboard operations, decision conflict detection, graph traversal, context assembly, archiving
3. **Embeddings layer** (`src/embeddings/`): Lazy-loaded ONNX embedder (singleton with concurrent-safe initialization), index manager, cosine similarity search
4. **Tools layer** (`src/tools/`): Thin MCP adapters that validate input, call engine, format output—one file per tool group
5. **Server wiring** (`src/server.ts`, `src/index.ts`): Singleton service registry, tool registration orchestration, stdio transport connection

**Critical architectural constraints:**
- No layer imports from layers above it (tools never import storage directly)
- All file I/O goes through storage layer with proper-lockfile protection
- Embeddings use dynamic import inside try/catch, never at module scope
- Tool handlers catch all errors and return structured responses, never throw
- Directory auto-initialization on first operation (zero-config progressive adoption)

**Build order** (bottom-up, each layer fully tested before next):
1. Utils (types, ids, tokens)
2. Storage (file-store, then blackboard/decision/graph stores)
3. Engine (blackboard, decisions, graph, archiver—no embeddings yet)
4. Embeddings (embedder, index-manager, search—isolated parallel path)
5. Wire embeddings into engine (context-assembler depends on all engines + search)
6. Tools (handlers for 5 tool groups)
7. Server (service registry, tool registration, transport)

### Critical Pitfalls

Eight critical pitfalls identified with prevention strategies mapped to build phases.

1. **stdout corruption via console.log in stdio transport** — Any `console.log` corrupts the JSON-RPC stream. Create `src/utils/logger.ts` wrapping `console.error`, add ESLint `no-console` rule, override `console.log = console.error` at startup. **Phase 1 (scaffolding).**

2. **Read-modify-write race conditions on JSON state files** — Concurrent agents updating `decisions/index.json`, `entities.json`, `relations.json` produce lost updates. Use `proper-lockfile` for entire read-modify-write cycle, implement in storage layer so engine never thinks about locking. **Phase 1 (storage layer).**

3. **JSONL append corruption from partial writes** — Crashes during `fs.appendFile` leave half-written lines. Always ensure trailing newline, lock even for appends, build resilient parser that skips corrupt last line. **Phase 1 (storage layer).**

4. **onnxruntime-node installation failures breaking server startup** — Native binary download fails behind proxies, on unsupported ARM64 Linux, or in restricted envs. Use dynamic `import()` inside async try/catch (never at module scope), set `embeddingsAvailable = false` on failure, test fallback path explicitly. **Phase 1 (scaffolding, embedding module).**

5. **MCP tool response size causing context window bloat** — Default limits too high (50 entries = thousands of tokens). Enforce hard token limits on ALL tools, default to summaries-only (detail is opt-in), measure actual token sizes (JSON overhead means 3 chars/token, not 4). **Phase 2 (tool handlers).**

6. **proper-lockfile stale lock accumulation under crash recovery** — SIGKILL leaves `.lock` directories. Use consistent stale/update values (10s timeout for most ops, longer for archiving), clean stale locks on startup, implement `compromised` callback to log when locks are stolen. **Phase 1 (storage layer).**

7. **Embedding index divergence from source data** — Entry written but embedding fails, or archive moves entries without rebuilding index. Treat embedding failures as non-fatal (entry still written), verify consistency on startup, rebuild index atomically during archive. **Phase 2 (embedding + archiver).**

8. **JSON state files growing without bound** — `entities.json`, `relations.json`, `decisions/index.json` loaded entirely into memory on every operation. Implement lazy-loaded in-memory cache, log warning when files exceed 1MB or 5,000 entities, consider graph cleanup tool. **Phase 2 (engine layer).**

**Additional high-impact pitfalls:**
- ULID collision in burst writes: Use `monotonicFactory()` not plain `ulid()`
- Token estimation inaccuracy: JSON overhead means 3 chars/token for structured output, not 4
- Path traversal in scope/affected_files: Validate all file paths are within project root
- Overlapping tool descriptions: Each tool needs unique name and "Use this when..." guidance

## Implications for Roadmap

Based on combined research findings, recommended 4-phase structure.

### Phase 1: Foundation (Storage + Blackboard Core)
**Rationale:** The storage layer is the foundation for everything. Blackboard CRUD + decision recording is the minimum viable thesis. Cannot build anything else until file operations are reliable and concurrent-safe. Addresses pitfalls 1-4 and 6 (the "server won't start" and "data corruption" class).

**Delivers:**
- Project scaffolding (package.json ESM fix, tsconfig types fix, logger utility, ESLint config)
- Utils (types, IDs with monotonic factory, token estimation)
- Storage layer (file-store with locking, blackboard-store, decision-store, graph-store)
- Engine layer (blackboard, decisions, graph—WITHOUT embeddings yet)
- Basic tools (twining_post, twining_read, twining_recent, twining_decide, twining_why, twining_status)
- Zero-config initialization

**Addresses features:**
- Persistent shared state (table stakes)
- Decision recording with rationale (core thesis)
- Decision retrieval by scope (table stakes)
- Structured error responses (table stakes)
- File-native storage (table stakes)

**Avoids pitfalls:**
- Stdout corruption (logger + ESLint)
- Race conditions (proper-lockfile everywhere)
- JSONL corruption (resilient append + parser)
- Stale locks (startup cleanup + consistent timeouts)

**Testing focus:** Concurrent write tests, kill-during-write recovery, lock contention simulation.

**Research flag:** Standard patterns—no additional research needed. Build follows MCP reference implementation patterns.

---

### Phase 2: Intelligence (Embeddings + Context Assembly)
**Rationale:** Semantic search and context assembly are the key differentiators. Embeddings must be lazy-loaded with complete fallback (addresses pitfall 4). Context assembly is the highest-value feature—no other MCP server does this. Addresses pitfalls 5, 7, and 8 (the "scaling and usability" class).

**Delivers:**
- Embeddings layer (lazy-loaded embedder, index manager, cosine similarity search)
- Wire embeddings into existing engine (blackboard posts, decision posts)
- Context assembler (weighted scoring: recency + relevance + confidence + warning boost)
- Context tools (twining_assemble, twining_summarize, twining_what_changed, twining_query)
- Token budget enforcement on ALL tool responses
- Embedding index consistency checks

**Addresses features:**
- Semantic search (table stakes)
- Keyword fallback (table stakes)
- Context assembly with token budgeting (primary differentiator)
- Change tracking (differentiator)

**Avoids pitfalls:**
- onnxruntime install failures (dynamic import + fallback tested)
- Context window bloat (token limits enforced, summaries default)
- Embedding index divergence (consistency checks on startup)

**Uses stack elements:**
- onnxruntime-node with ONNX model download
- Cosine similarity brute-force (acceptable at <500 entries with archiving)

**Testing focus:** Embedding unavailable tests, token budget accuracy, large dataset query performance.

**Research flag:** Standard patterns—ONNX loading and cosine similarity are well-documented. No additional research needed.

---

### Phase 3: Lifecycle + Graph (Complete the Experience)
**Rationale:** The knowledge graph and lifecycle features (archiving, reconsider, override) round out the blackboard experience. Decision dependency chains (`twining_trace`) and conflict detection are novel features. These are lower priority than context assembly but required for production use.

**Delivers:**
- Decision lifecycle (twining_reconsider, twining_override)
- Decision tracing (twining_trace following depends_on/supersedes)
- Conflict detection (same domain + scope + different summary)
- Graph tools (twining_add_entity, twining_add_relation, twining_neighbors, twining_graph_query)
- Auto graph population from decisions (create entities for affected files)
- Archiver (twining_archive with summarization)
- In-memory caching for graph files (address pitfall 8)

**Addresses features:**
- Decision dependency chains (differentiator)
- Decision lifecycle (differentiator)
- Conflict detection (differentiator)
- Code-aware knowledge graph (differentiator)
- Archiving with summarization (differentiator)
- Human override workflow (differentiator)

**Avoids pitfalls:**
- JSON state file growth (in-memory cache)
- Embedding index divergence during archiving (atomic rebuild)

**Testing focus:** Graph traversal performance, archive index rebuild, conflict detection accuracy.

**Research flag:** Standard patterns. Graph traversal and archiving follow established patterns. No additional research needed.

---

### Phase 4: Polish + Integration (Production Ready)
**Rationale:** Integration features (git hooks, export), UX improvements (better error messages, tool description refinement), performance optimizations (index partitioning if needed), and hardening (security validation, startup repair tools).

**Delivers:**
- Path traversal validation for all file inputs
- Secret detection filter (warn on potential secrets in blackboard posts)
- Tool description refinement based on real usage (eliminate confusion)
- Export tool (twining_export for markdown dump)
- Startup validation and repair (detect corrupt files, rebuild indexes)
- Performance monitoring (log when files exceed thresholds)
- Optional: Git commit hooks for post-commit state snapshots

**Addresses features:**
- Scope-aware operations refinement (handle trailing slash edge cases)
- Human override audit trail improvements

**Avoids pitfalls:**
- Path traversal (security)
- Tool confusion (UX)
- Silent state corruption (startup validation)

**Testing focus:** Adversarial input tests, startup validation with corrupt state, real-world usage patterns.

**Research flag:** May need research for git hooks integration (Phase 4 optional feature).

---

### Phase Ordering Rationale

**Why this order:**
- **Storage first:** Nothing works without reliable file operations. Concurrency bugs and corruption pitfalls must be addressed at the foundation.
- **Blackboard + decisions before embeddings:** The core thesis is structured decision tracking. Semantic search enhances it but is not the thesis itself.
- **Context assembly after embeddings:** Context assembly depends on semantic search for relevance scoring. Must have embeddings working before building the assembler.
- **Graph + lifecycle after context assembly:** These features are valuable but not on the critical path. Context assembly is the key differentiator that justifies using Twining over simpler memory servers.
- **Polish last:** Integration and UX refinement require real usage data to be effective.

**Dependency-driven grouping:**
- Phase 1 establishes the foundation (storage → engine → basic tools)
- Phase 2 adds intelligence (embeddings → context assembly)
- Phase 3 completes the feature set (graph + lifecycle using established foundation)
- Phase 4 hardens for production (validation + security + UX)

**Pitfall mitigation sequencing:**
- Critical corruption/startup pitfalls (1-4, 6) addressed in Phase 1
- Scaling/usability pitfalls (5, 7, 8) addressed in Phase 2
- Security/edge case pitfalls addressed in Phase 4

### Research Flags

**Phases with standard patterns (skip research-phase):**
- **Phase 1:** File I/O, locking, JSONL, MCP tool registration—all well-documented in SDK and proper-lockfile docs
- **Phase 2:** ONNX loading, cosine similarity—reference implementations available, design spec already prescribes approach
- **Phase 3:** Graph traversal, archiving—standard algorithms, no novel techniques

**Phases where deeper research MIGHT be useful (but not required):**
- **Phase 4 (git hooks):** IF we add post-commit hooks, may need research on hook reliability and Claude Code integration

**Overall:** The design spec is comprehensive and prescriptive. The research validates that all prescribed technologies are current and appropriate. No gaps that would require additional research during phase planning. Proceed directly to requirements definition.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified against npm registry 2026-02-16. MCP SDK v1.26, onnxruntime-node v1.24.1, proper-lockfile v4.1.2, Zod v4, Vitest v4 are all current and stable. |
| Features | HIGH | 6+ competitive implementations analyzed (Official Memory, Memory Keeper, Memory Service, memory-mcp, Agent-MCP, Claude-flow). Table stakes and differentiators clearly identified. |
| Architecture | HIGH | Layered architecture validated against MCP reference implementations. Build order grounded in dependency graph. All patterns (lazy loading, locking, singleton registry) are proven. |
| Pitfalls | HIGH | Grounded in design spec analysis, MCP SDK documentation, Node.js filesystem semantics, onnxruntime issue trackers, and multiple MCP best practices guides. Prevention strategies mapped to build phases. |

**Overall confidence:** HIGH

The design spec is unusually comprehensive and prescriptive. Research confirms that all technical choices are sound and current as of 2026-02-16. The competitive analysis shows clear differentiation. The pitfalls are grounded in real issues from Node.js file I/O, native addon distribution, and MCP protocol constraints.

### Gaps to Address

**Minor gaps (resolvable during implementation):**
- **Token estimation calibration:** The 4-chars-per-token heuristic needs empirical validation with actual Twining JSON responses. Address in Phase 2 during context assembly testing.
- **Embedding index binary serialization:** If the index exceeds 5,000 entries, JSON serialization of 384-dim float vectors becomes inefficient. Consider binary format (Buffer or typed arrays) only if this becomes a measured problem.
- **In-memory cache eviction policy:** Design spec mentions in-memory caching for graph files but does not specify eviction. Simple write-through cache is fine initially; add LRU eviction only if memory usage becomes a problem.

**No blocking gaps:** All core decisions are validated. No areas require additional research before beginning Phase 1 implementation.

## Sources

### Primary (HIGH confidence)
- Design spec: `TWINING-DESIGN-SPEC.md` — prescribes architecture, data models, tool signatures
- MCP TypeScript SDK — [GitHub](https://github.com/modelcontextprotocol/typescript-sdk) and [server.md docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) — verified v1.26 API
- Official MCP Memory Server — [GitHub](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) — reference implementation patterns
- npm registry (`npm view` on 2026-02-16) — all version numbers verified directly
- proper-lockfile — [GitHub](https://github.com/moxystudio/node-proper-lockfile) and npm — verified API and gotchas
- onnxruntime-node — [npm](https://www.npmjs.com/package/onnxruntime-node) and [releases](https://onnxruntime.ai/docs/reference/releases-servicing.html) — platform support verified
- HuggingFace Xenova/all-MiniLM-L6-v2 — [model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — ONNX weights and usage examples

### Secondary (MEDIUM confidence)
- MCP Memory Service — [GitHub](https://github.com/doobidoo/mcp-memory-service) — hybrid search implementation reference
- MCP Memory Keeper — [GitHub](https://github.com/mkreyman/mcp-memory-keeper) — SQLite patterns and tool count analysis
- memory-mcp — [GitHub](https://github.com/yuvalsuede/memory-mcp) — CLAUDE.md auto-update patterns
- Agent-MCP — [GitHub](https://github.com/rinadelph/Agent-MCP) — multi-agent coordination anti-patterns
- Claude-flow — [GitHub](https://github.com/ruvnet/claude-flow) — consensus algorithms as over-engineering example
- Stigmergic Blackboard Protocol — [GitHub](https://github.com/AdviceNXT/sbp) — blackboard pattern validation
- Building Multi-Agent Systems with Blackboard Pattern — [Medium article](https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern-to-build-systems-a454705d5672)
- MCP Best Practices — [The New Stack](https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/) and [WorkOS](https://workos.com/blog/mcp-features-guide)
- MCP Token Bloat Strategies — [The New Stack](https://thenewstack.io/how-to-reduce-mcp-token-bloat/)
- MCP Tool Overload — [Lunar.dev](https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents)
- Claude Code Documentation — [Subagents](https://code.claude.com/docs/en/sub-agents), [MCP](https://code.claude.com/docs/en/mcp), [Agent Teams](https://claudefa.st/blog/guide/agents/agent-teams)
- Implementing MCP Tips and Pitfalls — [Nearform](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/)
- Node.js File Locking — [LogRocket](https://blog.logrocket.com/understanding-node-js-file-locking/)
- Cosine Similarity TypeScript — [alexop.dev](https://alexop.dev/posts/how-to-implement-a-cosine-similarity-function-in-typescript-for-vector-comparison/)

### Issue Trackers (HIGH confidence for pitfalls)
- onnxruntime Linux install bug — [Issue #24918](https://github.com/microsoft/onnxruntime/issues/24918)
- Node.js fs.writeFile corruption — [Issue #1058](https://github.com/nodejs/node/issues/1058), [Help #2346](https://github.com/nodejs/help/issues/2346)
- ULID monotonic ordering — [spec](https://github.com/ulid/spec)
- MCP tool response truncation — [Claude Code Issue #2638](https://github.com/anthropics/claude-code/issues/2638)

---

**Research completed:** 2026-02-16
**Ready for roadmap:** Yes
**Confidence level:** HIGH
**Recommended next step:** Proceed to requirements definition. All research files committed together.
