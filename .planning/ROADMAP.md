# Roadmap: Twining MCP Server

## Overview

Twining delivers a shared coordination layer for AI agents, built bottom-up from reliable file-native storage through structured decision tracking and blackboard state, up to semantic search and context assembly. Phase 1 establishes the working MCP server with the core thesis (agents share *why* decisions were made). Phase 2 adds the intelligence layer (semantic search and token-budgeted context assembly) that differentiates Twining from simpler memory servers. Phase 3 completes the experience with the knowledge graph, full decision lifecycle, and archiving.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation + Core Data** - Storage layer, blackboard, basic decisions, and MCP server wiring
- [ ] **Phase 2: Intelligence** - Embeddings, semantic search, and token-budgeted context assembly
- [ ] **Phase 3: Graph + Lifecycle** - Knowledge graph, decision lifecycle (trace/reconsider/override/conflict), and archiving

## Phase Details

### Phase 1: Foundation + Core Data
**Goal**: Agents can post to a shared blackboard, record decisions with rationale, and query both -- served as a working MCP server over stdio
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06, BLKB-01, BLKB-02, BLKB-04, BLKB-05, BLKB-06, DCSN-01, DCSN-02, DCSN-06, MCPI-01, MCPI-02, MCPI-03
**Success Criteria** (what must be TRUE):
  1. Agent connects to Twining via stdio and receives tool listings; `.twining/` directory is auto-created on first tool call
  2. Agent can post a blackboard entry with type/summary/tags/scope, then read it back filtered by type, tags, scope, or recency
  3. Agent can record a decision with rationale, alternatives, and confidence, then retrieve all decisions affecting a given scope via `twining_why`
  4. Two concurrent agents can write to the blackboard and decision store without data corruption
  5. All tool calls return structured JSON responses (never crash the MCP connection), including for invalid inputs
**Plans**: 2 plans in 2 waves

Plans:
- [x] 01-01-PLAN.md — Utils, config, and storage layer (types, IDs, tokens, file-store with locking, blackboard-store, decision-store, init)
- [x] 01-02-PLAN.md — Engine layer and MCP server (blackboard engine, decision engine, tool handlers with Zod schemas, server wiring, stdio transport)

### Phase 2: Intelligence
**Goal**: Agents get semantic search across all stored data and can request tailored, token-budgeted context packages for any task
**Depends on**: Phase 1
**Requirements**: EMBD-01, EMBD-02, EMBD-03, EMBD-04, BLKB-03, CTXA-01, CTXA-02, CTXA-03, CTXA-04
**Success Criteria** (what must be TRUE):
  1. Agent can search blackboard entries by natural language query and get semantically relevant results (not just keyword matches)
  2. If ONNX runtime fails to load, server continues working with keyword-based search fallback -- never crashes
  3. Agent can request assembled context for a task+scope and receive a package of relevant decisions, blackboard entries, and summaries within a specified token budget
  4. Agent can see what changed since a given timestamp and get a high-level summary of project state
**Plans**: TBD

Plans:
- [ ] 02-01: Embeddings layer (lazy-loaded ONNX embedder, index manager, cosine similarity search, keyword fallback)
- [ ] 02-02: Context assembly engine and tools (assembler with weighted scoring, summarize, what_changed, wire into MCP tools)

### Phase 3: Graph + Lifecycle
**Goal**: Agents can build and traverse a knowledge graph of code entities, manage the full decision lifecycle (trace, reconsider, override, conflict detection), and archive old state
**Depends on**: Phase 2
**Requirements**: GRPH-01, GRPH-02, GRPH-03, GRPH-04, DCSN-03, DCSN-04, DCSN-05, DCSN-07, LIFE-01, LIFE-02, LIFE-03, LIFE-04
**Success Criteria** (what must be TRUE):
  1. Agent can add entities and relationships to the knowledge graph, then traverse neighbors and query by name/properties
  2. Agent can trace a decision's dependency chain upstream and downstream, and flag a decision for reconsideration with new context
  3. A human can override a decision with a reason, and the system detects when a new decision contradicts an existing active decision in the same scope
  4. Agent can archive old blackboard entries (generating a summary finding), while decisions remain permanently unarchived
  5. Agent can check overall health and status of the Twining state
**Plans**: TBD

Plans:
- [ ] 03-01: Knowledge graph engine and tools (entities, relations, neighbors, graph_query)
- [ ] 03-02: Decision lifecycle and archiving (trace, reconsider, override, conflict detection, archive with summarization, status)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation + Core Data | 2/2 | Complete | 2026-02-16 |
| 2. Intelligence | 0/2 | Not started | - |
| 3. Graph + Lifecycle | 0/2 | Not started | - |
