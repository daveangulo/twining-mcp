# Requirements: Twining MCP Server

**Defined:** 2026-02-16
**Core Value:** Agents share *why* decisions were made, not just *what* was done — eliminating information silos across context windows.

## v1.1 Requirements

Requirements for v1.1 Integrations + Polish. Each maps to roadmap phases.

### GSD Planning Bridge

- [ ] **GSDB-01**: Context assembly includes `.planning/` state (current phase, progress, blockers) when relevant to the task scope
- [ ] **GSDB-02**: `twining_summarize` includes planning state (phase, progress, open requirements) in its output
- [ ] **GSDB-03**: When `twining_decide` is called, decision summary is appended to STATE.md accumulated context section
- [ ] **GSDB-04**: `twining_assemble` scores planning context alongside blackboard/decisions — phase requirements and progress surface when task relates to a planning scope

### Git Commit Linking

- [ ] **GITL-01**: `twining_decide` accepts optional `commit_hash` parameter to associate a decision with a commit at creation time
- [ ] **GITL-02**: New `twining_link_commit` tool links an existing decision ID to a commit hash retroactively
- [ ] **GITL-03**: `twining_why` includes associated commit hashes in its output for linked decisions
- [ ] **GITL-04**: New `twining_commits` tool queries decisions by commit hash — "what decisions drove this commit?"

### Serena Workflow

- [ ] **SRNA-01**: CLAUDE.md documents the agent-mediated workflow for enriching the knowledge graph from Serena symbol analysis after `twining_decide`

### Decision Search

- [ ] **SRCH-01**: New `twining_search_decisions` tool finds decisions via semantic similarity search across summaries, rationale, and context
- [ ] **SRCH-02**: `twining_search_decisions` supports optional filters: domain, status, confidence level

### Export

- [ ] **XPRT-01**: New `twining_export` tool dumps full Twining state as a single markdown document (blackboard entries, decisions, graph entities/relations)
- [ ] **XPRT-02**: `twining_export` accepts optional `scope` parameter to filter output to relevant subset

## Future Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Multi-Agent Coordination

- **MAGN-01**: Agent registration with capability declaration
- **MAGN-02**: Need/offer matching and task routing between agents
- **MAGN-03**: Agent heartbeat and liveness tracking

### Advanced Intelligence

- **INTL-01**: Learned relevance weights from user feedback
- **INTL-02**: Embedding-based conflict detection
- **INTL-03**: Decision impact analysis across codebase

## Out of Scope

| Feature | Reason |
|---------|--------|
| Hook-based pending-posts/actions processing | CLAUDE.md workflows preferred over hook plumbing |
| Direct MCP-to-MCP communication (Twining ↔ Serena) | MCP architecture doesn't support server-to-server calls; agent-mediated pattern chosen |
| Web dashboard | Separate project/milestone — different tech stack |
| Cross-repo Twining state | Needs design work beyond current scope |
| Real-time collaboration | File-native storage doesn't support real-time sync |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| GSDB-01 | — | Pending |
| GSDB-02 | — | Pending |
| GSDB-03 | — | Pending |
| GSDB-04 | — | Pending |
| GITL-01 | — | Pending |
| GITL-02 | — | Pending |
| GITL-03 | — | Pending |
| GITL-04 | — | Pending |
| SRNA-01 | — | Pending |
| SRCH-01 | — | Pending |
| SRCH-02 | — | Pending |
| XPRT-01 | — | Pending |
| XPRT-02 | — | Pending |

**Coverage:**
- v1.1 requirements: 13 total
- Mapped to phases: 0
- Unmapped: 13

---
*Requirements defined: 2026-02-16*
*Last updated: 2026-02-16 after initial definition*
