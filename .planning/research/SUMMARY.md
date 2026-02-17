# Research Summary: Agent Coordination for Twining v1.3

**Domain:** Agent Registry, Capability Matching, Delegation, and Handoffs
**Researched:** 2026-02-17
**Overall confidence:** HIGH

## Executive Summary

Agent coordination integrates cleanly into Twining's existing architecture because the blackboard pattern already provides 80% of the necessary infrastructure. The blackboard's "need" and "offer" entry types are the delegation mechanism. The context assembler is the handoff context packager. The knowledge graph can store agent-capability relationships. What's missing is a thin layer: an agent registry (who exists and what they can do), structured delegation metadata (capability requirements on needs), structured handoff records (results with context snapshots), and a matching engine (connecting needs to capable agents).

The key architectural insight is that delegations should NOT be a separate data structure -- they are blackboard entries with structured metadata in the detail field. This preserves the single-source-of-truth principle, ensures existing tools (read, query, recent, assemble) already surface delegations, and avoids fragmenting the context assembly pipeline. Agents without v1.3 tools can still see delegations as regular "need" entries.

The design follows Twining's established patterns rigorously: upsert-by-name (matching GraphStore entities), individual files + index (matching DecisionStore), optional constructor parameters (matching ContextAssembler's graph/planning integration), and inferred status from timestamps (avoiding heartbeat overhead in the token-conscious MCP environment).

No new npm dependencies are needed. The entire coordination layer is built using existing TypeScript, file-store utilities, proper-lockfile, and ULID generation. This milestone adds 3 new storage files (.twining/agents/registry.json, .twining/handoffs/index.json, .twining/handoffs/{ulid}.json), 2 new source modules (agent-store.ts, handoff-store.ts in storage; agent-engine.ts in engine), 1 new tool file (agent-tools.ts), and minor extensions to 4 existing modules (types.ts, init.ts, context-assembler.ts, lifecycle-tools.ts, server.ts).

## Key Findings

**Stack:** No new dependencies. Built entirely on existing TypeScript + file-store + proper-lockfile + ULID stack.

**Architecture:** Thin coordination layer sits beside (not above) existing blackboard/decisions/graph. Agent registry as JSON file with upsert-by-name. Delegations as blackboard entries with structured metadata. Handoff records following decision store pattern. Context assembler extended with optional handoff/agent awareness.

**Critical pitfall:** Do NOT create a separate delegation queue. Delegations are blackboard entries. Creating a parallel structure fragments state, breaks context assembly, and doubles maintenance.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Foundation: Types + Storage** - Build data models and storage layer first
   - Addresses: AgentRecord, HandoffRecord, HandoffIndexEntry types; agent-store.ts, handoff-store.ts; init.ts extensions
   - Avoids: Circular dependency pitfall by establishing stores before engines

2. **Engine: Registration, Discovery, Delegation, Handoff** - Business logic
   - Addresses: agent-engine.ts with register, discover, delegate, handoff methods
   - Avoids: Forced assignment anti-pattern by returning suggestions, not assignments

3. **Integration: Tools + Assembly + Status** - Connect to MCP surface and extend existing modules
   - Addresses: agent-tools.ts (5 new tools), context-assembler.ts extension, lifecycle-tools.ts extension, server.ts wiring
   - Avoids: Backward compatibility breakage by using optional params

4. **Dashboard: API + UI** - Read-only visualization of agent state
   - Addresses: /api/agents, /api/handoffs endpoints; Agents tab with registry/delegations/handoffs views
   - Avoids: Tab proliferation by using view-mode toggles within single tab

**Phase ordering rationale:**
- Phase 1 has zero engine dependencies -- pure types and storage CRUD
- Phase 2 depends on Phase 1 stores + existing engines (stable)
- Phase 3 modifies existing modules minimally with optional additions
- Phase 4 is pure read-only display, safest to build last
- This mirrors the existing build order: utils -> storage -> engine -> tools -> dashboard

**Research flags for phases:**
- Phase 1: Standard patterns, unlikely to need research
- Phase 2: Delegation matching logic may need iteration -- start with simple AND-match on capabilities
- Phase 3: Context assembler integration needs careful testing against existing test suite
- Phase 4: Standard dashboard extension, well-understood from v1.2

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No new dependencies; proven existing stack |
| Features | HIGH | Feature set derived from spec section 12 + codebase analysis |
| Architecture | HIGH | Design follows established codebase patterns exactly |
| Pitfalls | HIGH | Pitfalls identified from codebase analysis and multi-agent research |

## Gaps to Address

- **Capability vocabulary conventions**: Should document recommended capability tag conventions in CLAUDE.md (e.g., always lowercase, use broad categories). Not a code gap -- a documentation gap.
- **Activity tracking mechanism**: How exactly does `last_active` get updated? Two options: (a) every tool handler updates it explicitly, or (b) a middleware in server.ts updates it on any tool call with an `agent_id`. Option (b) is cleaner but requires investigating MCP SDK middleware patterns. This should be resolved during Phase 2 implementation.
- **Handoff archival policy**: Handoff records persist like decisions. Should old handoffs be archivable? Probably not in v1.3 -- keep it simple. Monitor file growth.
- **Dashboard polling vs. agent tab UX**: The 3-second polling interval is fine for the existing tabs. For the Agents tab, liveness status changes slowly (minutes, not seconds), so polling is more than adequate. No gap here -- just confirming.

## Sources

- [Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture](https://arxiv.org/html/2507.01701v1)
- [Four Design Patterns for Event-Driven Multi-Agent Systems](https://www.confluent.io/blog/event-driven-multi-agent-systems/)
- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams)
- [MCP Registry](https://github.com/modelcontextprotocol/registry)
- [Best Practices for Multi-Agent Orchestration and Reliable Handoffs](https://skywork.ai/blog/ai-agent-orchestration-best-practices-handoffs/)
- [Advancing Multi-Agent Systems Through Model Context Protocol](https://arxiv.org/abs/2504.21030)
- [Agent-to-Agent Collaboration Models for Complex Business Workflows](https://www.theamericanjournals.com/index.php/tajet/article/view/7396)
- Twining codebase: TWINING-DESIGN-SPEC.md, server.ts, context-assembler.ts, blackboard.ts, graph.ts, types.ts, all stores
