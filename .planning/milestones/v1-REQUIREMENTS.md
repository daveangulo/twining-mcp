# Requirements Archive: v1 Twining MCP Server

**Archived:** 2026-02-17
**Status:** SHIPPED

For current requirements, see `.planning/REQUIREMENTS.md`.

---

# Requirements: Twining MCP Server

**Defined:** 2026-02-16
**Core Value:** Agents share *why* decisions were made, not just *what* was done — eliminating information silos across context windows.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Foundation

- [ ] **FOUND-01**: Server auto-creates `.twining/` directory with default config and empty data files on first tool call
- [ ] **FOUND-02**: All IDs are ULIDs (temporally sortable, unique across concurrent agents)
- [ ] **FOUND-03**: All file writes use advisory file locking to prevent corruption from concurrent access
- [ ] **FOUND-04**: All tool handlers return structured error responses, never crash the MCP connection
- [ ] **FOUND-05**: Token estimation available (4 chars per token heuristic) for context budget management
- [ ] **FOUND-06**: Config loaded from `.twining/config.yml` with sensible defaults

### Blackboard

- [ ] **BLKB-01**: Agent can post entries to shared blackboard with type, summary, detail, tags, and scope
- [ ] **BLKB-02**: Agent can read blackboard entries filtered by type, tags, scope, and time
- [ ] **BLKB-03**: Agent can search blackboard entries by natural language query (semantic search)
- [ ] **BLKB-04**: Agent can retrieve the N most recent blackboard entries
- [ ] **BLKB-05**: Blackboard entries are stored as append-only JSONL in `.twining/blackboard.jsonl`
- [ ] **BLKB-06**: Blackboard supports 10 entry types: need, offer, finding, decision, constraint, question, answer, status, artifact, warning

### Decisions

- [ ] **DCSN-01**: Agent can record a decision with full rationale, alternatives, constraints, and confidence level
- [ ] **DCSN-02**: Agent can retrieve all decisions affecting a given scope or file (`twining_why`)
- [ ] **DCSN-03**: Agent can follow the dependency chain of a decision upstream and downstream (`twining_trace`)
- [ ] **DCSN-04**: Agent can flag a decision for reconsideration with new context (`twining_reconsider`)
- [ ] **DCSN-05**: Human can override a decision with reason (`twining_override`)
- [ ] **DCSN-06**: Decisions are stored as individual JSON files with an index for fast lookup
- [ ] **DCSN-07**: Conflict detection flags when a new decision contradicts an existing active decision in the same scope

### Context Assembly

- [ ] **CTXA-01**: Agent can request tailored context for a task+scope, assembled from decisions, blackboard entries, and graph within a token budget
- [ ] **CTXA-02**: Agent can get a high-level summary of project or scope state (`twining_summarize`)
- [ ] **CTXA-03**: Agent can see what changed since a given timestamp (`twining_what_changed`)
- [ ] **CTXA-04**: Context assembly uses weighted scoring: recency, relevance, decision confidence, warning boost

### Knowledge Graph

- [ ] **GRPH-01**: Agent can add entities to the knowledge graph (module, function, class, file, concept, pattern, dependency, api_endpoint)
- [ ] **GRPH-02**: Agent can add relationships between entities (depends_on, implements, decided_by, affects, tested_by, calls, imports, related_to)
- [ ] **GRPH-03**: Agent can find entities connected to a given entity with configurable depth (`twining_neighbors`)
- [ ] **GRPH-04**: Agent can search entities by name or properties (`twining_graph_query`)

### Embeddings

- [ ] **EMBD-01**: Semantic search uses local ONNX embeddings (all-MiniLM-L6-v2, 384 dimensions)
- [ ] **EMBD-02**: Embedding model is lazy-loaded on first use, not at server startup
- [ ] **EMBD-03**: If ONNX fails to load, server falls back to keyword-based search without crashing
- [ ] **EMBD-04**: Embeddings are generated for every blackboard entry and decision

### Lifecycle

- [ ] **LIFE-01**: Agent can archive old blackboard entries to reduce active set size
- [ ] **LIFE-02**: Archive generates a summary finding of archived content
- [ ] **LIFE-03**: Decision entries are never archived (permanent record)
- [ ] **LIFE-04**: Agent can check overall health/status of Twining state (`twining_status`)

### MCP Integration

- [ ] **MCPI-01**: Server registers all tools via MCP SDK with proper Zod schemas
- [ ] **MCPI-02**: Server connects via stdio transport for Claude Code integration
- [ ] **MCPI-03**: Server is installable via `npx twining-mcp`

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Multi-Agent Coordination

- **MAGT-01**: Agent registration and capability matching
- **MAGT-02**: Self-selection task routing via need/offer matching
- **MAGT-03**: Agent heartbeat and status tracking

### Integrations

- **INTG-01**: Serena MCP integration for automatic code entity population
- **INTG-02**: GSD `.planning/` state synchronization
- **INTG-03**: Git commit linking (auto-tag decisions with commit hashes)
- **INTG-04**: Web dashboard for human oversight

### Advanced Intelligence

- **ADVN-01**: Improved relevance algorithm with learned weights
- **ADVN-02**: Automatic decision conflict detection via embedding similarity
- **ADVN-03**: Cross-repo Twining state via shared git repos
- **ADVN-04**: Decision impact analysis

## Out of Scope

| Feature | Reason |
|---------|--------|
| HTTP transport | Claude Code uses stdio; HTTP adds complexity with no current consumer |
| Real-time notifications / WebSocket | MCP protocol is request-response over stdio |
| External database (SQLite, Redis) | File-native design principle — all state in plain files |
| Mobile or web UI | CLI-first, MCP tool interface only |
| Multi-repo federation | Single-project scope for v1; cross-repo is Phase 4 |
| Custom embedding models | all-MiniLM-L6-v2 is sufficient; model swapping adds complexity |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 | Phase 1 | Pending |
| FOUND-02 | Phase 1 | Pending |
| FOUND-03 | Phase 1 | Pending |
| FOUND-04 | Phase 1 | Pending |
| FOUND-05 | Phase 1 | Pending |
| FOUND-06 | Phase 1 | Pending |
| BLKB-01 | Phase 1 | Pending |
| BLKB-02 | Phase 1 | Pending |
| BLKB-03 | Phase 2 | Pending |
| BLKB-04 | Phase 1 | Pending |
| BLKB-05 | Phase 1 | Pending |
| BLKB-06 | Phase 1 | Pending |
| DCSN-01 | Phase 1 | Pending |
| DCSN-02 | Phase 1 | Pending |
| DCSN-03 | Phase 3 | Pending |
| DCSN-04 | Phase 3 | Pending |
| DCSN-05 | Phase 3 | Pending |
| DCSN-06 | Phase 1 | Pending |
| DCSN-07 | Phase 3 | Pending |
| CTXA-01 | Phase 2 | Pending |
| CTXA-02 | Phase 2 | Pending |
| CTXA-03 | Phase 2 | Pending |
| CTXA-04 | Phase 2 | Pending |
| GRPH-01 | Phase 3 | Pending |
| GRPH-02 | Phase 3 | Pending |
| GRPH-03 | Phase 3 | Pending |
| GRPH-04 | Phase 3 | Pending |
| EMBD-01 | Phase 2 | Pending |
| EMBD-02 | Phase 2 | Pending |
| EMBD-03 | Phase 2 | Pending |
| EMBD-04 | Phase 2 | Pending |
| LIFE-01 | Phase 3 | Pending |
| LIFE-02 | Phase 3 | Pending |
| LIFE-03 | Phase 3 | Pending |
| LIFE-04 | Phase 3 | Pending |
| MCPI-01 | Phase 1 | Pending |
| MCPI-02 | Phase 1 | Pending |
| MCPI-03 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 38 total
- Mapped to phases: 38
- Unmapped: 0

---
*Requirements defined: 2026-02-16*
*Last updated: 2026-02-16 after roadmap creation*
