# Feature Landscape

**Domain:** Agent coordination / shared state MCP server for Claude Code
**Researched:** 2026-02-16
**Overall confidence:** MEDIUM-HIGH

## Table Stakes

Features users expect from an MCP server that coordinates agents and provides shared state. Missing = tool is not worth installing.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Persistent shared state (blackboard)** | Core value proposition. Every memory/coordination MCP server provides this. Without it, agents lose context between sessions and across subagents. MCP Memory Keeper, memory-mcp, and the official Memory server all solve this as their primary function. | Medium | Twining's typed entry system (need/offer/finding/decision/etc.) is more structured than competitors' free-form observations. JSONL append-only is the right storage model -- matches the official Memory server pattern. |
| **Read/write/query operations** | Basic CRUD on shared state. Every comparable server (MCP Memory, Memory Keeper, Agent-MCP) provides create, read, search, and delete. Users cannot do anything useful without these. | Low | `twining_post`, `twining_read`, `twining_recent` -- standard operations. Keep tool count minimal per anti-pattern research. |
| **Filtering and scoping** | Multi-agent workflows generate noise. Without filtering by type, scope, tags, or time, the blackboard becomes a firehose. MCP Memory Keeper provides 38 tools in full mode but most are filtering variants. | Low | Scope-prefix matching is a good design. Tags provide secondary filtering axis. Resist creating separate filter tools -- use parameters on existing tools. |
| **Decision recording with rationale** | The "why" gap is the core problem statement. Memory-mcp tracks "decisions" as one of six memory categories. Agent-MCP stores "architectural decisions and patterns." But most store decisions as flat text, not structured records. | Medium | `twining_decide` with structured alternatives, constraints, and confidence is table stakes for THIS product specifically -- it is the central thesis. Without it, Twining is just another memory server. |
| **Decision retrieval by scope** | If you record decisions but cannot ask "why was this file designed this way?", the recording is pointless. Every decision tool needs a corresponding query tool. | Low | `twining_why` is critical. Scope-based lookup (file, module, symbol) is the natural query pattern for developers. |
| **Semantic search** | Expected in 2025-2026. MCP Memory Service uses hybrid BM25 + vector. Memory-mcp provides `memory_search`. CodeGrok, Claude Context, and Qdrant MCP all provide semantic search. Keyword-only search feels broken when agents generate natural language entries. | High | Local ONNX with graceful fallback to keyword search is the right call. The ~23MB model download is acceptable. Brute-force cosine similarity is fine for <10k entries. |
| **Keyword search fallback** | ONNX runtime can fail on some platforms (ARM Linux, restricted environments). The server must never refuse to start. MCP Memory Service documents multiple fallback strategies. | Low | Required by design spec. This is not optional -- it is a hard constraint. |
| **Status/health check** | Standard for production MCP servers. Users need to verify the server is running and see state at a glance. Memory Keeper provides `memory_stats`. | Low | `twining_status` -- entry counts, last activity, archiving status. Cheap to build, high value for debugging. |
| **Zero-config initialization** | Auto-create `.twining/` on first tool call. Every successful MCP server (Memory, Memory Keeper, memory-mcp) creates its storage automatically. Requiring manual setup is a dealbreaker for adoption. | Low | Design spec already requires this. `.twining/` with defaults on first call. |
| **Structured error responses** | MCP best practice per Docker and New Stack guidance. Tool handlers that throw crash the agent's reasoning chain. All comparable servers return structured error objects. | Low | `{ error: true, message: "...", code: "..." }` pattern. Never throw from tool handlers. |
| **File-native, git-trackable storage** | Differentiator that is also table stakes for the target audience (developers using Claude Code). The official MCP Memory server uses line-delimited JSON. Memory-mcp stores in `.memory/state.json`. Developers expect to `git diff` their project state. | Low | JSONL for append-only streams, JSON for structured documents. `.gitignore` for binary indexes. This is a core design principle, not negotiable. |

## Differentiators

Features that set Twining apart from existing MCP memory/coordination servers. Not expected by users coming from simpler tools, but create clear competitive advantage.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Structured decision records with alternatives** | No existing MCP server captures rejected alternatives with pros/cons/rationale. MCP Memory Keeper stores flat "decisions" text. Agent-MCP stores "architectural decisions" as unstructured context. Twining's `Decision` model with `alternatives[]`, `constraints[]`, `confidence`, `depends_on` is unique in the ecosystem. | Medium | This is the primary differentiator. The structured format enables tracing, conflict detection, and impact analysis that flat text cannot support. |
| **Decision dependency chains** | `twining_trace` following upstream/downstream decision dependencies is novel. No comparable MCP server offers decision graph traversal. Agent-MCP has task dependencies but not decision dependencies. | Medium | `depends_on` and `supersedes` fields enable chain traversal. High value for understanding cascading impacts when reconsidering a decision. |
| **Decision lifecycle (reconsider, override)** | `twining_reconsider` and `twining_override` provide a formal process for evolving decisions. No competitor has this. Memory-mcp has "confidence decay" over time but no active reconsideration workflow. | Low | These are lightweight operations (status changes + blackboard posts) but they formalize a workflow that is currently ad-hoc in every other tool. |
| **Conflict detection** | Automatic detection of contradictory decisions in the same scope/domain. Flagged as warnings, not silently accepted. No comparable MCP server does this. | Medium | Same-domain + same-scope + different-summary heuristic is a reasonable starting point. Embedding-based conflict detection is a Phase 4 improvement. |
| **Context assembly with token budgeting** | `twining_assemble` builds a tailored context package for a specific task and scope within a token budget. No other MCP server assembles context -- they all return raw search results. This directly addresses the "ballooning context" problem documented across the MCP ecosystem. | High | The weighted scoring algorithm (recency, relevance, decision confidence, warning boost) is the most complex feature. It is also the highest-value feature for reducing context bloat. |
| **Typed entry taxonomy** | 10 entry types (need, offer, finding, decision, constraint, question, answer, status, artifact, warning) vs. the 5 types in MCP Memory Service or flat observations in the official Memory server. The taxonomy enables the blackboard pattern where agents self-select work based on entry types. | Low | The taxonomy is defined in types, not in separate tools. One `twining_post` tool handles all types. This avoids the tool bloat anti-pattern. |
| **Knowledge graph** | Lightweight entity-relation graph for code structure. The official MCP Memory server has a knowledge graph, but it stores arbitrary entities. Twining's graph is code-aware (module, function, class, file, concept, pattern, dependency, api_endpoint) with code-aware relations (depends_on, implements, decided_by, calls, imports). | Medium | Graph auto-population from `twining_decide` (creating entities for affected files/symbols with "decided_by" relations) is the key differentiator vs. manual-only graph construction. |
| **Change tracking** | `twining_what_changed` reports new decisions, entries, overrides, and reconsiderations since a timestamp. Purpose-built for the "new agent picking up where the last left off" workflow. No comparable feature in other MCP memory servers. | Low | Simple timestamp filtering on existing data. High value for context handoff between agent sessions. |
| **Archiving with summarization** | `twining_archive` moves old entries to archive files, optionally generating a summary. Prevents unbounded state growth that plagues append-only systems. Memory-mcp has confidence decay; Twining has explicit archiving. | Medium | Decisions are never archived (permanent record). Summary posting as a "finding" entry preserves institutional knowledge. |
| **Scope-aware operations** | Prefix-based scope matching (file path, module, "project") threads through every operation. Queries naturally narrow to what is relevant. No other MCP server has this pervasive scope concept. | Low | `src/auth/jwt.ts` matches `src/auth/` matches `project`. Built into data model, not bolted on. |
| **Human override workflow** | `twining_override` with explicit `overridden_by` and `override_reason` fields creates an audit trail for human intervention. Addresses the "human-in-the-loop" requirement that enterprise teams demand. | Low | Simple status change + metadata recording. Differentiating because it acknowledges that AI decisions need human governance. |

## Anti-Features

Features to explicitly NOT build. These are tempting but would hurt the product.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Agent registration and management** | Out of scope for Phase 1. Claude Code already manages agent spawning via Task() and subagents. Adding `create_agent`, `list_agents`, `terminate_agent` (like Agent-MCP) duplicates Claude Code's built-in capabilities and creates a maintenance burden. Claude Code's Agent Teams feature already handles this. | Let Claude Code manage agents. Twining coordinates through shared state, not agent lifecycle. Phase 2 consideration only. |
| **Direct agent-to-agent messaging** | The blackboard pattern explicitly avoids point-to-point communication. Agent-MCP's `send_agent_message` and `broadcast_message` create coupling between agents. SBP (Stigmergic Blackboard Protocol) demonstrates that coordination works better through environment-based signals than direct messaging. | Use typed blackboard entries (need/offer/question/answer) for coordination. Agents read the blackboard, not each other's mail. |
| **Web dashboard** | Premature for Phase 1. Claude-flow provides a web UI but it adds significant complexity (HTTP server, frontend, WebSocket). The file-native storage model means users can already inspect state with `jq`, `cat`, and their editor. | Defer to Phase 3. File-native storage IS the dashboard for now. Consider `twining_export` for markdown dump before building a web UI. |
| **Cloud sync or multi-device support** | MCP Memory Service offers Cloudflare Workers sync. This adds infrastructure complexity, authentication, and data privacy concerns. Twining's value is local-first, git-trackable state. | Store in `.twining/` in the project directory. Share via git (the files are git-trackable by design). Cross-machine sync is git push/pull. |
| **Emotional metadata / sentiment analysis** | MCP Memory Service tracks valence, arousal, and emotion classification. This is irrelevant for code coordination. It adds complexity without value for the developer audience. | Focus on structured, factual metadata: confidence levels, decision status, entry types. |
| **Automatic memory extraction from transcripts** | Memory-mcp uses Haiku LLM to automatically extract memories from conversation transcripts via hooks. This requires LLM API calls (cost, latency, privacy concerns) and produces unpredictable quality. | Explicit tool calls only. Agents deliberately post to the blackboard. Quality over automation. The agent decides what is worth remembering, not a background process. |
| **SQLite or database storage** | MCP Memory Keeper and Claude-flow use SQLite. This breaks git-trackability, requires binary file handling, and adds a dependency. JSONL/JSON is human-readable, diffable, and mergeable. | Stick with JSONL + JSON files. Evaluate `proper-lockfile` for concurrency. Consider SQLite WAL only if concurrent access at scale becomes a proven problem (design spec section 10.1 TODOs). |
| **Too many tools (>20)** | MCP Memory Keeper exposes up to 38 tools. Research shows this causes tool selection confusion, context bloat (tools consume ~500-2000 tokens each in context), and degraded agent reasoning. Microsoft Research documents that similar-sounding tools cause misfires. | Keep to ~17 tools as specified. Use parameters for filtering variants rather than separate tools. One `twining_read` with filter params, not `twining_read_by_type`, `twining_read_by_tag`, `twining_read_by_scope`. |
| **Real-time agent heartbeats** | Agent-MCP and Claude-flow track agent heartbeats and status. Claude Code agents are ephemeral -- they do not have persistent processes to heartbeat. This adds complexity for a runtime model that does not exist. | Use blackboard "status" entries for agent activity tracking. Post on start, post on completion. No polling or heartbeat infrastructure. |
| **Consensus algorithms or CRDT** | Claude-flow implements Raft, BFT, Gossip, CRDT, and weighted voting. This is massive over-engineering for a local MCP server where the primary consumer is one human's Claude Code sessions. | Human-in-the-loop conflict resolution via `twining_override`. Flag conflicts, do not auto-resolve them. |
| **Configurable tool profiles** | MCP Memory Keeper offers Minimal (8 tools), Standard (22), and Full (38) profiles. This complexity is necessary because they have too many tools. With a disciplined ~17 tool count, profiles are unnecessary. | Ship all tools. Keep the count manageable enough that profiles are not needed. |
| **Episodic memory tracking** | MCP Memory Service tracks episode_id, sequence_number, preceding_memory_id for conversation episodes. This is useful for chatbot memory but irrelevant for code coordination where the unit of work is a task, not a conversation turn. | Use the existing timestamp + ULID ordering. Entries are temporally ordered by ID. No need for explicit episode tracking. |

## Feature Dependencies

```
Zero-config init ──> All other features (nothing works without .twining/)

File storage layer ──> Blackboard ──> Post/Read/Recent/Query
                   ──> Decision store ──> Decide/Why/Trace/Reconsider/Override
                   ──> Graph store ──> Add Entity/Add Relation/Neighbors/Graph Query

Blackboard + Decision store ──> Context Assembly (assembles from both)
Blackboard + Decision store ──> What Changed (queries both)
Blackboard ──> Archive (moves blackboard entries)

Embedding system ──> Semantic search (Query tool)
Embedding system ──> Context assembly relevance scoring

Decision store ──> Conflict detection (triggered by Decide)
Decision store ──> Decision lifecycle (Reconsider, Override)
Decision store ──> Decision trace (follows depends_on chain)

Decision store + Graph store ──> Auto graph population (Decide creates entities)
```

**Critical path:** File storage --> Blackboard + Decision store --> Context assembly --> Semantic search

**Parallel paths:** Knowledge graph can be built independently of context assembly. Archiving can be built independently of semantic search.

## MVP Recommendation

### Must ship (Phase 1 core -- without these, Twining has no reason to exist):

1. **Blackboard CRUD** (`twining_post`, `twining_read`, `twining_recent`) -- Shared state is the foundation. Without it, nothing else works.
2. **Decision recording** (`twining_decide`) -- Structured decisions with rationale is the thesis.
3. **Decision retrieval** (`twining_why`, `twining_trace`) -- If you cannot query decisions, recording them is pointless.
4. **Status** (`twining_status`) -- Users need to verify the system is working.
5. **File-native storage** -- JSONL + JSON in `.twining/`. Zero-config init.
6. **Structured errors** -- Never crash the agent.

### Should ship (Phase 1 complete -- these round out the experience):

7. **Semantic search** (`twining_query`) -- With keyword fallback. Upgrades the blackboard from a log to a queryable knowledge base.
8. **Context assembly** (`twining_assemble`, `twining_summarize`, `twining_what_changed`) -- The highest-value differentiator. Without it, agents must manually search and filter.
9. **Decision lifecycle** (`twining_reconsider`, `twining_override`) -- Formalizes the evolution of decisions.
10. **Knowledge graph** (`twining_add_entity`, `twining_add_relation`, `twining_neighbors`, `twining_graph_query`) -- Adds structural awareness.
11. **Archiving** (`twining_archive`) -- Prevents unbounded growth.

### Defer (Phase 2+):

- **Agent registration / capability matching** -- Phase 2 when multi-agent patterns are proven.
- **Auto conflict detection via embeddings** -- Phase 4 intelligence upgrade.
- **Web dashboard** -- Phase 3 integration.
- **Git commit linking** -- Phase 3 integration.
- **Cross-repo state sharing** -- Phase 4.
- **Decision impact analysis** -- Phase 4.
- **`twining_export` (markdown dump)** -- Nice-to-have, consider for late Phase 1 or Phase 2.
- **`twining_search_decisions` (keyword search without knowing scope)** -- Design spec TODO, low urgency since `twining_query` covers semantic search.

## Competitive Landscape Summary

| Capability | Official MCP Memory | MCP Memory Keeper | MCP Memory Service | memory-mcp | Agent-MCP | Claude-flow | **Twining** |
|------------|--------------------|--------------------|-------------------|------------|-----------|-------------|-------------|
| Persistent state | Yes (KG) | Yes (SQLite) | Yes (SQLite/Cloud) | Yes (JSON) | Yes (KG) | Yes (SQLite) | **Yes (JSONL/JSON)** |
| Semantic search | No | Full-text only | Hybrid BM25+vector | Keyword | RAG query | HNSW vector | **Local ONNX + fallback** |
| Decision tracking | No | Flat text | Category only | Category only | Unstructured | No | **Structured with alternatives** |
| Decision chains | No | No | No | No | Task deps only | No | **Yes (depends_on/supersedes)** |
| Conflict detection | No | No | No | No | No | BFT/CRDT | **Yes (scope+domain heuristic)** |
| Context assembly | No | No | No | No | No | No | **Yes (token-budgeted)** |
| Knowledge graph | Yes (generic) | No | D3.js viz | No | Yes (generic) | PageRank | **Yes (code-aware)** |
| Human override | No | No | No | No | No | No | **Yes (formal workflow)** |
| Git-trackable | Yes (JSONL) | No (SQLite) | No (SQLite) | Yes (JSON) | Partial | No (SQLite) | **Yes (JSONL/JSON)** |
| Tool count | 9 | 8-38 | ~10 | ~8 | ~12 | Many | **17** |

**Twining's unique position:** The only MCP server that combines structured decision tracking, context assembly with token budgeting, and a blackboard coordination pattern -- all backed by git-trackable files. It is not trying to be a general-purpose memory server; it is a coordination layer for multi-agent development workflows.

## Sources

### Competitor Implementations
- [Official MCP Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) - Reference knowledge graph implementation
- [MCP Memory Service](https://github.com/doobidoo/mcp-memory-service) - Full-featured memory with hybrid search
- [MCP Memory Keeper](https://github.com/mkreyman/mcp-memory-keeper) - SQLite-based persistent context
- [memory-mcp](https://github.com/yuvalsuede/memory-mcp) - Auto-updated CLAUDE.md memory
- [Agent-MCP](https://github.com/rinadelph/Agent-MCP) - Multi-agent coordination framework
- [Claude-flow](https://github.com/ruvnet/claude-flow) - Enterprise agent orchestration

### Architecture Patterns
- [Stigmergic Blackboard Protocol (SBP)](https://github.com/AdviceNXT/sbp) - Environment-based agent coordination
- [Agent Blackboard](https://github.com/claudioed/agent-blackboard) - Multi-agent blackboard for software engineering
- [Building Intelligent Multi-Agent Systems with MCPs and the Blackboard Pattern](https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern-to-build-systems-a454705d5672)

### MCP Ecosystem
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Features Guide (WorkOS)](https://workos.com/blog/mcp-features-guide)
- [15 Best Practices for Building MCP Servers in Production](https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/)
- [10 Strategies to Reduce MCP Token Bloat](https://thenewstack.io/how-to-reduce-mcp-token-bloat/)
- [How to Prevent MCP Tool Overload](https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents)

### Claude Code Integration
- [Claude Code Subagents Documentation](https://code.claude.com/docs/en/sub-agents)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)
- [Claude Code Agent Teams Guide](https://claudefa.st/blog/guide/agents/agent-teams)
- [Context Window and Compaction](https://deepwiki.com/anthropics/claude-code/3.3-session-and-conversation-management)
