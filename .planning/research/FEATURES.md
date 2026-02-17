# Feature Landscape: Agent Coordination for Twining v1.3

**Domain:** Agent Registry, Capability Matching, Delegation, and Handoffs
**Researched:** 2026-02-17

## Table Stakes

Features that make the coordination layer functional. Missing any of these and the feature set is incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Agent registration (auto + explicit) | Agents must be discoverable before coordination is possible | Low | Upsert-by-name, mirrors GraphStore entity pattern |
| Capability self-description | Free-form capability tags that agents declare at registration | Low | String array, no taxonomy needed |
| Agent discovery by capability | "Who can do X?" is the fundamental question for delegation | Low | Linear scan with tag matching, registry is small |
| Liveness inference from activity | Must know if an agent is still around without heartbeats | Low | Timestamp comparison, inferred status |
| Delegation needs with capability requirements | Post a need that specifies what skills are required to fulfill it | Med | Structured metadata in blackboard detail field |
| Capability-need matching | System suggests which registered agents match a delegation | Med | AND-match on required caps, scored by overlap |
| Structured handoff records | Capture result + context snapshot when work is completed | Med | New store following DecisionStore pattern |
| Handoff context snapshot | Preserve decision/warning state at handoff creation time | Med | IDs + summaries, not full objects |
| Context assembly integration | `twining_assemble` includes relevant handoff results | Med | Optional param extension to existing assembler |
| `twining_agents` status tool | List all registered agents with their capabilities and status | Low | Simple registry read + status inference |
| Status tool extension | `twining_status` shows registered/active agent counts | Low | Add counts to existing lifecycle tool |

## Differentiators

Features that go beyond basic coordination and add meaningful value.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Delegation urgency levels | High/normal/low urgency helps agents prioritize which needs to pick up | Low | Field on delegation metadata |
| Delegation timeout/expiry | Auto-expire needs that nobody picks up after N hours | Low | Timestamp comparison on read |
| Handoff acceptance tracking | Consumer acknowledges handoff, creating a closed loop | Low | Status field on handoff record |
| Capability-matched suggestions in context assembly | When assembling context, suggest available agents that could help | Med | Lightweight -- agent names + caps in assembled output |
| Agent graph integration | Agents as knowledge graph entities with "can_do" relations | Med | Enables graph queries like "who affects auth module?" |
| Dashboard agents tab | Visual display of agent registry, pending delegations, handoff history | Med | Read-only dashboard extension |
| Delegation matching scoring | Score agents by capability overlap + scope proximity + liveness | Med | Multi-signal scoring like context assembly |
| Cross-session handoff persistence | Handoff records survive session restarts for async workflows | Low | File-native storage, same as decisions |

## Anti-Features

Features to explicitly NOT build in v1.3.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Agent-to-agent messaging | MCP has no push channel; messaging is just polling the blackboard with extra steps | Post to blackboard; agents read what's relevant |
| Forced task assignment | Violates blackboard self-selection principle; MCP can't push to agents | Return suggestions; agents voluntarily pick up work |
| Capability taxonomy/ontology | Over-engineering; capabilities evolve; governance burden | Free-form string tags with substring matching |
| Agent authentication/authorization | Not needed for local-only single-user MCP server | Trust agent_id as self-reported identifier |
| Heartbeat/keepalive protocol | Wastes tokens; MCP is request/response; no background channel | Infer liveness from last_active timestamp |
| Real-time delegation notifications | No push mechanism in MCP; would require WebSocket which is out of scope | Agents poll via `twining_read` or `twining_assemble` |
| Separate delegation queue | Duplicates the blackboard; fragments context assembly | Delegations are blackboard entries with structured metadata |
| Full context serialization in handoffs | Handoff records become enormous; context is already in referenced entries | Store IDs and summaries; consumer uses `twining_assemble` |
| Agent orchestrator/supervisor | Adds complexity; the human + blackboard pattern already coordinates | Let agents self-organize through blackboard visibility |

## Feature Dependencies

```
types.ts extensions
  -> agent-store.ts (needs AgentRecord type)
  -> handoff-store.ts (needs HandoffRecord type)

init.ts extensions
  -> agent-store.ts (needs directories to exist)
  -> handoff-store.ts (needs directories to exist)

agent-store.ts
  -> agent-engine.ts (registration, discovery depend on store)

handoff-store.ts
  -> agent-engine.ts (handoff creation depends on store)

blackboard-engine.ts (unchanged)
  -> agent-engine.ts (delegation posts needs to blackboard)

context-assembler.ts
  -> handoff-store.ts (handoff awareness in assembly)
  -> agent-store.ts (agent suggestions in assembly)

agent-engine.ts
  -> agent-tools.ts (tool handlers call engine)
  -> server.ts (wiring)

agent-tools.ts + context-assembler extensions + lifecycle-tools extensions
  -> Dashboard API + UI (read from stores)
```

## MVP Recommendation

Prioritize (Phase 1 + 2, sufficient for working coordination):
1. Agent registration with capability tags (table stakes)
2. Agent discovery by capability (table stakes)
3. Liveness inference (table stakes)
4. Delegation needs with capability matching (table stakes)
5. Structured handoffs with context snapshots (table stakes)
6. Context assembly integration (table stakes)
7. `twining_agents` and status extension (table stakes)

Defer to Phase 3+:
- Dashboard agents tab: adds visibility but agents work without it
- Agent graph integration: nice enrichment, not needed for core workflow
- Delegation scoring: simple AND-match is sufficient initially
- Delegation timeout/expiry: can be manual initially

## Sources

- Twining codebase analysis -- existing patterns (BlackboardEngine.post, ContextAssembler, GraphStore upsert)
- [Blackboard Architecture for Multi-Agent Systems](https://arxiv.org/html/2507.01701v1) -- agent selection, self-organization
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents) -- Claude Code delegation patterns
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) -- shared task lists, coordination overhead
