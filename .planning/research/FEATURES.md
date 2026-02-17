# Feature Research: Web Dashboard for Twining MCP

**Domain:** Embedded Developer Tool Dashboard
**Researched:** 2026-02-16
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Real-time operational metrics** | Every developer dashboard shows system health at a glance | LOW | Display: blackboard entry count, active/provisional decisions, graph entities/relations, last activity timestamp. Already available via `twining_status`. Matches pattern from DevOps observability tools. |
| **Search and filter UI** | Users expect to find specific entries without reading everything | MEDIUM | Text search across blackboard/decisions/graph. Filter by: entry_type, tags, scope, date range, status. Pattern: Chrome DevTools network filter supports text, regex, property filters (e.g., `status-code:404`, `domain:example.com`). |
| **Entry list/table view** | Standard way to browse state in developer tools | LOW | Paginated list with sortable columns (timestamp, type, summary, scope). Chrome DevTools and Redux DevTools use this pattern universally. |
| **Detail inspector** | Click an entry to see full details | LOW | Click blackboard entry/decision → show full detail panel. React DevTools pattern: tree view on left, detail panel on right. |
| **Auto-refresh/live updates** | Developer tools show live state, not stale snapshots | MEDIUM | Poll `twining_status` and data endpoints every 2-5 seconds. WebSockets overkill for v1. GraphQL Playground uses polling. |
| **Dark mode support** | Developer tools universally support dark themes | LOW | CSS variables for theming. Modern browser DevTools default to dark. Redis Commander specifically calls out dark mode as expected. |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Interactive knowledge graph visualization** | Unique to Twining — visualize entity/relation structure | HIGH | D3.js or similar for force-directed graph. Features: zoom/pan, click node to expand neighbors, color-code by entity type, highlight decision-linked entities. Reference: Cambridge Intelligence knowledge graph tools show interactive zoom/pan/expand as standard. |
| **Decision timeline with rationale** | Show decision evolution over time with full context | MEDIUM | Horizontal timeline (KronoGraph pattern) showing decisions chronologically. Click decision → show full rationale, alternatives, constraints. Time-travel aspect borrowed from Redux DevTools. |
| **Semantic search with highlighting** | Leverage Twining's ONNX embeddings for relevance search | MEDIUM | Search returns semantically similar results, not just keyword matches. Highlight matching terms. Differentiates from pure keyword search. |
| **Cross-reference navigation** | Click `relates_to` or `depends_on` IDs to jump to referenced entries | LOW | Hyperlink IDs in detail panels. Browser DevTools pattern: clickable references. Enables exploration without manual search. |
| **Decision confidence heatmap** | Visual indicator of provisional vs high-confidence decisions | LOW | Color-code decisions by confidence level (high=green, medium=yellow, low=red, provisional=orange). Port.io dashboard patterns emphasize visual KPI status. |
| **Scope-based filtering** | Filter entire UI to a codebase scope (e.g., `src/auth/`) | MEDIUM | Persistent scope filter affects all views (blackboard, decisions, graph). Useful for large projects. Pattern from IDE project trees. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Real-time WebSocket updates** | Feels modern, instant updates | Adds complexity (connection management, reconnect logic, server state). Polling every 2-5s is sufficient for developer tool observability. | Simple polling with 2-5s interval. GraphQL Playground uses polling successfully. |
| **Embedded code editor** | "Let me edit decisions/entries inline" | Scope creep — Twining MCP tools already handle CRUD. Embedded editor = Monaco bundling, syntax highlighting, validation. Heavy. | Read-only display with "Edit in MCP" instructions. Keep dashboard as observer/navigator, not mutator. |
| **Custom dashboards/widgets** | "Let users configure their view" | Premature optimization. No evidence users need customization in v1. Adds persistence layer for UI config. | Fixed, opinionated layout. Gather feedback, add customization in v2 if requested. |
| **Export to PDF/CSV from UI** | "I want to share this report" | `twining_export` already produces markdown. PDF generation = headless browser or complex library. CSV = deciding schema for graph data. | Use existing `twining_export` markdown. Users can convert markdown to PDF/CSV with external tools if needed. |
| **Inline editing of blackboard/decisions** | Convenience | Violates single source of truth (`.twining/` files are canonical). UI state sync issues. MCP tools are the write interface. | Display-only UI. Use MCP tools for mutations. Show "Use `twining_post` to add entries" hints. |

## Feature Dependencies

```
[Search UI]
    └──requires──> [Entry list view]
                       └──requires──> [Detail inspector]

[Semantic search]
    └──requires──> [Search UI]
    └──requires──> [ONNX embeddings available]

[Knowledge graph visualization]
    └──requires──> [Graph data endpoint]
    └──enhances──> [Decision timeline] (show decision → affected entities)

[Decision timeline]
    └──requires──> [Decision list API]
    └──enhances──> [Detail inspector] (click timeline item → detail panel)

[Scope filtering]
    └──enhances──> [All views] (global filter state)

[Auto-refresh]
    └──conflicts──> [Large dataset rendering] (re-render 500+ entries every 2s = jank)
```

### Dependency Notes

- **Search UI requires Entry list view:** Search results display as filtered list. List view must exist first.
- **Semantic search requires Search UI:** Builds on existing search, adds ONNX ranking. Progressive enhancement.
- **Knowledge graph visualization requires Graph data endpoint:** Frontend needs `/api/graph` to fetch entities/relations JSON.
- **Decision timeline enhances Detail inspector:** Timeline is navigation layer. Inspector is destination.
- **Scope filtering enhances All views:** Global UI state. When scope = `src/auth/`, all lists filter to matching entries/decisions/entities.
- **Auto-refresh conflicts with Large dataset rendering:** Need virtual scrolling or pagination to prevent jank with 500+ entries re-rendering.

## MVP Definition

### Launch With (v1.2)

Minimum viable product — what's needed to validate the concept.

- [x] **Operational stats dashboard** — Display metrics from `twining_status`: blackboard count, active decisions, graph entities/relations, last activity, warnings. Essential: immediate value, no new backend required.
- [x] **Blackboard entry list with search/filter** — Paginated list of blackboard entries. Text search, filter by entry_type/tags/scope. Essential: core observability need, enables "what's happening?" questions.
- [x] **Decision list with search/filter** — Paginated list of decisions. Filter by status/domain/confidence. Essential: primary use case is "what did we decide and why?"
- [x] **Detail inspector panel** — Click entry/decision → show full detail (rationale, alternatives, constraints, related entries). Essential: summary lists are useless without drilling into detail.
- [x] **Knowledge graph visualization** — Interactive D3 force-directed graph. Click node → highlight neighbors. Color-code by entity type. Essential: differentiator, unique to Twining, makes graph data accessible.
- [x] **Decision timeline view** — Chronological timeline of decisions. Click → detail panel. Essential: shows decision evolution, complements list view.
- [x] **Auto-refresh (polling)** — Poll status/data every 5s. Essential: developer tool must show current state, not stale snapshot.
- [x] **Dark mode** — CSS dark theme. Essential: table stakes for developer tools.

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] **Semantic search** — Use ONNX embeddings for relevance ranking. Trigger: user feedback requests "better search" or "find similar decisions".
- [ ] **Scope-based filtering** — Global scope filter (e.g., show only `src/auth/`). Trigger: user feedback from projects with >100 decisions.
- [ ] **Decision confidence heatmap** — Visual color-coding by confidence. Trigger: user asks "which decisions need review?"
- [ ] **Export view to markdown** — Generate markdown report of current filtered view. Trigger: user requests "share this subset" functionality.
- [ ] **Cross-reference navigation** — Clickable links for `relates_to`, `depends_on`, `supersedes`. Trigger: user feedback shows navigation pain.

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Decision diff view** — Compare decision versions (original vs superseded). Trigger: evidence users track decision changes over time.
- [ ] **Graph query builder UI** — Visual query builder for `twining_graph_query`. Trigger: user feedback shows MCP tool too complex for common queries.
- [ ] **Customizable widgets/layout** — Drag-and-drop dashboard layout. Trigger: evidence of diverse user needs requiring different views.
- [ ] **Multi-project view** — Switch between multiple Twining projects. Trigger: users managing multiple codebases request project switching.
- [ ] **Metrics history charts** — Track blackboard count / decision count over time. Trigger: users request trend analysis.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Operational stats dashboard | HIGH | LOW | P1 |
| Blackboard entry list + search | HIGH | MEDIUM | P1 |
| Decision list + search | HIGH | MEDIUM | P1 |
| Detail inspector | HIGH | LOW | P1 |
| Knowledge graph visualization | MEDIUM | HIGH | P1 |
| Decision timeline | MEDIUM | MEDIUM | P1 |
| Auto-refresh | HIGH | MEDIUM | P1 |
| Dark mode | MEDIUM | LOW | P1 |
| Semantic search | MEDIUM | MEDIUM | P2 |
| Scope-based filtering | MEDIUM | MEDIUM | P2 |
| Decision confidence heatmap | LOW | LOW | P2 |
| Cross-reference navigation | MEDIUM | LOW | P2 |
| Decision diff view | LOW | MEDIUM | P3 |
| Graph query builder UI | LOW | HIGH | P3 |
| Customizable widgets | LOW | HIGH | P3 |
| Multi-project view | LOW | MEDIUM | P3 |
| Metrics history charts | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch (v1.2)
- P2: Should have, add when possible (v1.x)
- P3: Nice to have, future consideration (v2+)

## Competitor Feature Analysis

| Feature | Redux DevTools | React DevTools | GraphQL Playground | Apollo Studio | Our Approach |
|---------|---------------|----------------|-------------------|--------------|--------------|
| **State inspection** | Tree view, props/state display | Component hierarchy tree | Schema explorer | Schema reference | Blackboard/decision lists with detail inspector |
| **Time travel** | Replay actions, cancel actions | N/A | N/A | N/A | Decision timeline (view-only, no replay in v1) |
| **Search/filter** | Action type filter | Component name search | Full-text schema search | Operation search | Text + property filters (type, tags, scope, status) |
| **Real-time updates** | Live action stream | Live component tree | Manual refresh | Auto-refresh | Polling (2-5s interval) |
| **Graph visualization** | N/A | Component tree | Schema graph | Operation trace graph | Force-directed entity/relation graph |
| **Dark mode** | Yes | Yes | Yes | Yes | Yes (CSS variables) |

### Comparison Notes

**Redux DevTools** provides the gold standard for time-travel debugging. We adopt the timeline concept but defer replay/time-travel mutations to v2. View-only timeline in v1.

**React DevTools** demonstrates the tree-view + detail-panel pattern. We use this for blackboard/decision lists: summary view → click → detail panel.

**GraphQL Playground** shows that polling is acceptable for developer tool auto-refresh. No need for WebSocket complexity in v1.

**Apollo Studio** demonstrates advanced query building and schema exploration. We defer query builder UI to v2, provide MCP tools for v1.

**Redis Commander** emphasizes tree view for keys, batch operations, import/export. We adopt tree-like navigation (graph visualization) but keep mutations in MCP tools.

### Twining's Unique Position

Twining combines decision tracking (Redux DevTools-like rationale) + knowledge graph (Apollo-like structure visualization) + blackboard coordination (unique to multi-agent systems). No direct competitor does all three.

**Differentiation strategy:** Lead with knowledge graph visualization and decision timeline. These are unique to Twining and not found in standard developer observability tools.

## Data Dependencies on Twining Backend

### Available Data (v1.1)

| Data Source | Endpoint Pattern | What It Provides |
|-------------|------------------|------------------|
| `twining_status` | Direct MCP call or HTTP adapter | Metrics: blackboard_entries, active_decisions, provisional_decisions, graph_entities, graph_relations, last_activity, warnings |
| `blackboard.jsonl` | Read file directly or create HTTP endpoint | All blackboard entries with: id, timestamp, agent_id, entry_type, tags, relates_to, scope, summary, detail |
| `decisions/*.json` + `decisions/index.json` | Read files directly or create HTTP endpoint | All decisions with: id, timestamp, domain, scope, summary, context, rationale, constraints, alternatives[], depends_on, supersedes, confidence, status, affected_files, affected_symbols |
| `graph/entities.json` | Read file directly or create HTTP endpoint | All entities with: id, name, type, properties, created_at, updated_at |
| `graph/relations.json` | Read file directly or create HTTP endpoint | All relations with: id, source, target, type, properties, created_at |
| `embeddings/*.index` | Binary ONNX index | Semantic search vectors (optional, graceful fallback) |

### New Endpoints Needed for Dashboard

Dashboard cannot call MCP tools directly (MCP is stdio). Need HTTP adapter or direct file reads.

**Option 1: Direct file reads (simplest)**
- Dashboard server reads `.twining/*.jsonl` and `.twining/**/*.json` files
- No MCP coupling
- Risk: file locking conflicts if server reads while MCP writes

**Option 2: HTTP adapter wrapping MCP tools**
- Thin HTTP server that calls MCP tools internally
- Maintains single source of truth
- More complex: requires MCP SDK in HTTP process

**Recommendation:** Option 1 with read-only access. Use `proper-lockfile` for safe concurrent reads.

## Sources

**Observability Dashboard Patterns:**
- [Top 10 Observability Platforms in 2026](https://openobserve.ai/blog/top-10-observability-platforms/)
- [10 observability tools platform engineers should evaluate in 2026](https://platformengineering.org/blog/10-observability-tools-platform-engineers-should-evaluate-in-2026)
- [How to Build a Developer Productivity Dashboard](https://jellyfish.co/library/developer-productivity/dashboard/)
- [DevOps Dashboard Ultimate Guide: Metrics And Use Cases](https://www.cloudzero.com/blog/devops-dashboard/)

**Developer Tool UI Patterns:**
- [Redux DevTools: Time Travel Debugging](https://medium.com/@AlexanderObregon/a-deep-dive-into-redux-devtools-debugging-and-analyzing-your-applications-state-b634ead3927b)
- [React Developer Tools – React](https://react.dev/learn/react-developer-tools/)
- [GraphQL Playground - Apollo GraphQL Docs](https://www.apollographql.com/docs/apollo-server/v2/testing/graphql-playground)
- [GraphOS Studio Explorer - Apollo GraphQL Docs](https://www.apollographql.com/docs/graphos/platform/explorer)

**State Inspection & Filtering:**
- [What are browser developer tools? - MDN](https://developer.mozilla.org/en-US/docs/Learn_web_development/Howto/Tools_and_setup/What_are_browser_developer_tools)
- [Filtering in Chrome DevTools](https://mattrossman.com/2024/06/28/filtering-in-chrome-devtools/)
- [Filter requests in the Network panel](https://devtoolstips.org/tips/en/filter-network-requests/)

**Knowledge Graph Visualization:**
- [Knowledge graph visualization: A comprehensive guide](https://datavid.com/blog/knowledge-graph-visualization)
- [Knowledge Graph Visualization | Enterprise Knowledge Management](https://cambridge-intelligence.com/use-cases/knowledge-graphs/)
- [Visualize knowledge graphs: bring your data to life](https://linkurious.com/blog/knowledge-graph-visualization/)

**Timeline Visualization:**
- [KronoGraph - Advanced Timeline Visualization](https://cambridge-intelligence.com/kronograph/)
- [Timeline Graph Visualization | Tom Sawyer Software](https://blog.tomsawyer.com/timeline-graph-visualization)

**Embedded Analytics:**
- [12 Best Embedded Analytics Tools for SaaS Teams in 2026](https://www.luzmo.com/blog/embedded-analytics-tools)
- [What Are Embedded Dashboards? A Detailed 2026 Guide](https://qrvey.com/blog/what-are-embedded-dashboards/)

**Vanilla JavaScript Dashboard Patterns:**
- [Why Developers Are Ditching Frameworks for Vanilla JavaScript](https://thenewstack.io/why-developers-are-ditching-frameworks-for-vanilla-javascript/)
- [How I Built a Real-Time Dashboard from Scratch Using Vanilla JavaScript](https://medium.com/@michaelpreston515/how-i-built-a-real-time-dashboard-from-scratch-using-vanilla-javascript-no-frameworks-f93f3dce98a9)

**Redis Admin Tools (State Browser Patterns):**
- [GitHub - joeferner/redis-commander](https://github.com/joeferner/redis-commander)
- [Redis GUI Showdown - The Best Clients for 2024](https://www.dragonflydb.io/guides/redis-gui)

---
*Feature research for: Twining MCP Server v1.2 Web Dashboard*
*Researched: 2026-02-16*
