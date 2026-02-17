# Requirements: Twining MCP Server

**Defined:** 2026-02-17
**Core Value:** Agents share *why* decisions were made, not just *what* was done — eliminating information silos across context windows.

## v1.3 Requirements

Requirements for v1.3 Agent Coordination milestone. Each maps to roadmap phases.

### Registry

- [ ] **REG-01**: Agent auto-registers on first Twining tool call with agent_id and timestamp
- [ ] **REG-02**: Agent can explicitly register with capabilities, role, and description via `twining_register`
- [ ] **REG-03**: Agent can declare capability tags as free-form strings
- [ ] **REG-04**: Agent liveness status inferred from last activity timestamp (active/idle/gone)

### Delegation

- [ ] **DEL-01**: Agent can discover other agents by capability tags via `twining_discover`
- [ ] **DEL-02**: Agent can post a delegation need with required capabilities to the blackboard
- [ ] **DEL-03**: System suggests matching agents when a delegation need is posted
- [ ] **DEL-04**: Agent can list all registered agents with capabilities and status via `twining_agents`
- [ ] **DEL-05**: `twining_status` shows registered and active agent counts
- [ ] **DEL-06**: Delegation needs support urgency levels (high/normal/low)
- [ ] **DEL-07**: Delegation needs auto-expire after configurable timeout
- [ ] **DEL-08**: Agents scored by capability overlap + liveness when matching delegations

### Handoff

- [ ] **HND-01**: Agent can create a structured handoff record with results and context
- [ ] **HND-02**: Handoff records include context snapshot (referenced decision/warning IDs and summaries)
- [ ] **HND-03**: `twining_assemble` includes relevant handoff results in context output
- [ ] **HND-04**: Handoff consumer can acknowledge receipt (acceptance tracking)
- [ ] **HND-05**: Handoff records persist across sessions (file-native storage)
- [ ] **HND-06**: Context assembly suggests available agents with matching capabilities

### Dashboard

- [ ] **DASH-01**: Dashboard includes Agents tab showing registered agents with status and capabilities
- [ ] **DASH-02**: Dashboard shows pending delegation needs with matching agent suggestions
- [ ] **DASH-03**: Dashboard shows handoff history with status

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Graph Integration

- **GRPH-01**: Agents as knowledge graph entities with "can_do" relations to capabilities
- **GRPH-02**: Graph queries like "who affects auth module?" via agent-capability-scope relations

### Advanced Coordination

- **ADVN-01**: Multi-agent registration and capability matching (formal protocol)
- **ADVN-02**: Learned relevance weights for delegation matching
- **ADVN-03**: Decision impact analysis across agent boundaries

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Agent-to-agent messaging | MCP has no push channel; messaging is just polling the blackboard with extra steps |
| Forced task assignment | Violates blackboard self-selection principle; MCP can't push to agents |
| Capability taxonomy/ontology | Over-engineering; free-form tags with substring matching sufficient |
| Agent authentication/authorization | Not needed for local-only single-user MCP server |
| Heartbeat/keepalive protocol | Wastes tokens; infer liveness from last_active timestamp |
| Real-time delegation notifications | No push mechanism in MCP; agents poll via twining_read or twining_assemble |
| Separate delegation queue | Duplicates the blackboard; fragments context assembly |
| Full context serialization in handoffs | Handoff records become enormous; store IDs and summaries instead |
| Agent orchestrator/supervisor | The human + blackboard pattern already coordinates |
| Cross-repo Twining state | Future milestone, not v1.3 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| REG-01 | — | Pending |
| REG-02 | — | Pending |
| REG-03 | — | Pending |
| REG-04 | — | Pending |
| DEL-01 | — | Pending |
| DEL-02 | — | Pending |
| DEL-03 | — | Pending |
| DEL-04 | — | Pending |
| DEL-05 | — | Pending |
| DEL-06 | — | Pending |
| DEL-07 | — | Pending |
| DEL-08 | — | Pending |
| HND-01 | — | Pending |
| HND-02 | — | Pending |
| HND-03 | — | Pending |
| HND-04 | — | Pending |
| HND-05 | — | Pending |
| HND-06 | — | Pending |
| DASH-01 | — | Pending |
| DASH-02 | — | Pending |
| DASH-03 | — | Pending |

**Coverage:**
- v1.3 requirements: 21 total
- Mapped to phases: 0
- Unmapped: 21 ⚠️

---
*Requirements defined: 2026-02-17*
*Last updated: 2026-02-17 after initial definition*
