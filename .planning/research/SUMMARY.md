# Project Research Summary

**Project:** Embedded Web Dashboard for Twining MCP Server
**Domain:** Developer Tool Observability UI
**Researched:** 2026-02-16
**Confidence:** HIGH

## Executive Summary

An embedded web dashboard can effectively complement Twining's MCP server without disrupting existing architecture. The research validates a "dual-transport" pattern where stdio handles agent interactions (MCP tools) while HTTP serves human monitoring on localhost. This is a proven approach demonstrated by Serena MCP and dual-transport MCP architectures.

The recommended approach uses native Node.js http module with vanilla HTML/CSS/JS (no build step), cytoscape.js for knowledge graph visualization, and vis-timeline for decision timelines. The dashboard runs on port 24282 in the same process as the MCP server, sharing the engine layer directly without protocol overhead. This keeps the stack minimal (3 new dependencies: cytoscape, vis-timeline, mime) while delivering interactive visualizations that make Twining's unique capabilities (knowledge graph, decision tracking) accessible to human users.

The primary risk is stdio corruption from HTTP logging. If the HTTP server writes to stdout, it breaks MCP communication entirely. This is prevented by configuring all HTTP logging to stderr from the start. Secondary risks include port conflicts (mitigated with fallback logic), large graph rendering freezing browsers (addressed with pagination/filtering), and polling performance issues (solved with caching and visibility-based polling). All critical pitfalls have well-understood preventions that must be implemented in Phase 1 before feature development.

## Key Findings

### Recommended Stack

The existing Twining stack remains unchanged. New additions focus exclusively on dashboard functionality with zero build steps and minimal dependencies.

**Core technologies:**
- **Native http module** (Node.js built-in) — Zero dependencies, 2x faster than Express for simple serving. Sufficient for <10 routes, no framework overhead.
- **cytoscape.js** (^3.33.1) — Interactive knowledge graph visualization with 10+ layout algorithms. 109KB gzipped, zero hard dependencies, best-in-class for network graphs with vanilla JS support.
- **vis-timeline** (^8.5.0) — Decision timeline visualization with zoom/pan/grouping. 186KB gzipped standalone build, handles 1000+ items efficiently.
- **mime** (^4.0.4) — MIME type detection for static file serving. 1.5KB, required for proper Content-Type headers with native http module.
- **Vanilla HTML/CSS/JS** (ES2022+) — No build step, no framework overhead. Dashboard is simple read-only views where frameworks would add complexity without value.

**Key architectural decision:** Polling over SSE/WebSockets. Dashboard polls every 2-5 seconds, which is sufficient for observability use case and dramatically simpler than bidirectional protocols.

### Expected Features

**Must have (table stakes):**
- Real-time operational metrics — blackboard count, active decisions, graph entities, last activity. Users expect system health at a glance.
- Search and filter UI — text search with filters by type, tags, scope, date range. Standard for developer tools (Chrome DevTools pattern).
- Entry list/table view — paginated, sortable blackboard entries and decisions.
- Detail inspector — click entry → full detail panel. React DevTools tree + detail pattern.
- Auto-refresh — poll state every 2-5 seconds. Developer tools show live state, not stale snapshots.
- Dark mode — CSS variables for theming. Table stakes for developer tools in 2026.

**Should have (competitive):**
- Interactive knowledge graph visualization — D3/cytoscape force-directed graph with zoom/pan/expand. Unique to Twining, makes graph data accessible.
- Decision timeline with rationale — chronological timeline showing decision evolution. Redux DevTools-inspired time-travel aspect.
- Cross-reference navigation — clickable IDs in detail panels for exploration without search.
- Decision confidence heatmap — visual color-coding by confidence level (high=green, provisional=orange).

**Defer (v2+):**
- Semantic search with ONNX embeddings — add when users request "better search" (v1.3+).
- Custom dashboards/widgets — no evidence users need customization in v1.
- Decision diff view — compare versions of superseded decisions.
- Multi-project switching — defer until users manage multiple codebases.

**Anti-features (don't build):**
- Real-time WebSocket updates — polling is sufficient, WebSockets add unnecessary complexity.
- Embedded code editor — scope creep, keep dashboard read-only.
- Inline editing — violates single source of truth (.twining/ files canonical, MCP tools are write interface).

### Architecture Approach

Dual-transport architecture: stdio for MCP tools, HTTP for dashboard, both in same Node.js process sharing the engine layer. Dashboard is read-only (no write API), preventing race conditions and authentication complexity. State access flows through existing stores (blackboard-store, decision-store, graph-store) with no duplication.

**Major components:**
1. **HTTP Server** (src/dashboard/server.ts) — Native http.createServer on localhost:24282, manual routing for 8 endpoints.
2. **Dashboard API Routes** (src/dashboard/routes.ts) — Read-only JSON endpoints: /api/status, /api/blackboard, /api/decisions, /api/graph, /api/search.
3. **Static File Server** (src/dashboard/static/) — Vanilla HTML/CSS/JS with cytoscape.js and vis-timeline, no build step, vendored dependencies.
4. **Integration Layer** (modified src/index.ts) — Conditionally starts HTTP server after stdio transport connects (config: dashboard.enabled, defaults true).

**Key pattern:** No-build frontend with vanilla JS. Server serves static HTML, minimal client-side code enhances with cytoscape/vis-timeline. Zero deployment complexity, instant load times.

### Critical Pitfalls

1. **stdio corruption from HTTP logging** — HTTP server writes to stdout, breaking MCP communication. Prevention: Configure all HTTP logging to stderr (manual log function writing to stderr), never use console.log in HTTP code, add lint rule to catch violations.

2. **Port binding conflicts in development** — Server crashes with EADDRINUSE on rapid restarts (Claude kills/spawns frequently). Prevention: Auto-increment port if default unavailable (24282→24283→...), implement graceful HTTP shutdown on SIGTERM, use SO_REUSEADDR.

3. **Lazy-load failure cascades to dashboard** — Embedding system fails (ONNX platform incompatibility), dashboard crashes instead of degrading gracefully. Prevention: Check `embedder.isAvailable()` before using, fallback to keyword search, show "Search (keyword mode)" badge in UI.

4. **Large graph rendering crashes browser** — Rendering 500+ entities freezes browser for 30+ seconds. Prevention: Implement pagination/filtering from start (depth=2 subgraphs), use cytoscape performance options (hideEdgesOnViewport, textureOnViewport), lazy load graph tab.

5. **Polling performance death spiral** — Multiple tabs polling every 1s causes file I/O spikes, slowing MCP tool responses. Prevention: Poll every 5s minimum, cache status for 2s, stop polling when tab hidden (document.visibilitychange).

6. **Graceful shutdown race condition** — SIGTERM closes stdio immediately but HTTP in-flight requests cause partial file writes, corrupting state. Prevention: Coordinate shutdown (HTTP server.close() → wait for in-flight → process.exit), reject new requests during shutdown, use proper-lockfile for all writes.

7. **Static asset path traversal vulnerability** — Crafted URLs like `/../../../.env` read sensitive files. Prevention: Use native path serving with validation (path.normalize + prefix check), never concatenate user input to filesystem paths without sanitization, add security test to CI.

8. **Asset bundling misconfiguration** — Dashboard works in dev, breaks in production (404 on all assets). Prevention: Vendor all dependencies in src/dashboard/static/lib/, no build step required, include static/ in package.json files array.

## Implications for Roadmap

Based on research, suggested phase structure emphasizes foundation-first with critical pitfall prevention before feature development:

### Phase 1: HTTP Server Foundation
**Rationale:** Must establish dual-transport coexistence and prevent stdio corruption before any features. This is the most critical phase — mistakes here break the entire MCP server.
**Delivers:** HTTP server running on localhost:24282 alongside stdio transport, with graceful shutdown, port fallback, and stderr-only logging.
**Addresses:** Core infrastructure need from FEATURES.md (table stakes for dashboard).
**Avoids:** Pitfall #1 (stdio corruption), #2 (port conflicts), #6 (shutdown race), #7 (path traversal).
**Research flag:** Standard pattern (well-documented in Serena MCP, dual-transport examples). Skip research-phase.

### Phase 2: Read-Only API Endpoints
**Rationale:** API layer provides data access for frontend. Must implement caching and embedding fallback before UI consumes data.
**Delivers:** GET /api/status, /api/blackboard, /api/decisions, /api/graph, /api/search with 2s caching, embedding availability checks, visibility-based polling.
**Uses:** Native http routing, mime package for static files, existing store layer.
**Implements:** Dashboard API Routes component from ARCHITECTURE.md.
**Avoids:** Pitfall #3 (embedding failure cascade), #5 (polling death spiral).
**Research flag:** Standard REST API pattern. Skip research-phase.

### Phase 3: Interactive Visualizations
**Rationale:** Core differentiator features (knowledge graph, decision timeline) require careful performance work. Builds on API layer from Phase 2.
**Delivers:** Knowledge graph page (cytoscape.js with pagination), decision timeline page (vis-timeline with zoom/grouping), detail inspector panels.
**Uses:** cytoscape.js (graph), vis-timeline (decisions), vanilla JS for glue code.
**Implements:** Dashboard UI features from FEATURES.md (table stakes + differentiators).
**Avoids:** Pitfall #4 (large graph rendering), #8 (asset bundling).
**Research flag:** Needs research-phase for cytoscape performance tuning and vis-timeline integration patterns. Complex domain with performance constraints.

### Phase 4: Polish & Deployment
**Rationale:** UX refinements and production readiness. Only after core functionality proven.
**Delivers:** Dark mode, empty states, loading indicators, keyboard navigation, production build verification.
**Addresses:** UX table stakes from FEATURES.md (dark mode, auto-refresh indicators).
**Uses:** CSS variables for theming, package.json files array for npm distribution.
**Avoids:** UX pitfalls (no empty states, silent fallbacks, no loading states).
**Research flag:** Standard UX patterns. Skip research-phase.

### Phase Ordering Rationale

- **Foundation first (Phase 1):** stdio corruption and shutdown races are catastrophic failures that break MCP entirely. Must be solved before features.
- **API before UI (Phase 2 → Phase 3):** Frontend depends on stable API endpoints with correct caching/fallback behavior. Polling performance must be validated with test data before UI rendering complexity.
- **Visualizations last (Phase 3):** Graph rendering is highest-complexity feature with most performance risk. Requires API layer complete for realistic testing with large datasets.
- **Polish deferred (Phase 4):** Dark mode and UX niceties don't affect core functionality. Add after MVP validated.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Interactive Visualizations):** Complex cytoscape.js performance tuning, vis-timeline customization, progressive rendering strategies. Domain has many performance pitfalls (see PITFALLS.md #4).

Phases with standard patterns (skip research-phase):
- **Phase 1 (HTTP Server Foundation):** Well-documented dual-transport pattern from Serena MCP and MCP specification examples.
- **Phase 2 (Read-Only API Endpoints):** Standard Node.js REST API with caching, established patterns.
- **Phase 4 (Polish & Deployment):** Common CSS theming and npm packaging patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All libraries verified, versions current, integration patterns validated. Native http module and vanilla JS are proven choices. cytoscape.js and vis-timeline are industry standards with extensive documentation. |
| Features | HIGH | Feature expectations derived from established developer tool patterns (Redux DevTools, React DevTools, GraphQL Playground). Table stakes vs differentiators clearly delineated. Anti-features identified from domain experience. |
| Architecture | HIGH | Dual-transport pattern demonstrated in Serena MCP reference implementation. Read-only dashboard with shared engine layer is battle-tested approach. No novel architecture, all components have precedent. |
| Pitfalls | HIGH | All critical pitfalls sourced from documented incidents (stdio corruption in MCP docs, cytoscape performance issues in GitHub issues, path traversal CVEs). Prevention strategies verified against official documentation. |

**Overall confidence:** HIGH

### Gaps to Address

**Graph rendering performance limits:** Research shows cytoscape.js struggles >200 entities, but exact threshold depends on edge count and styling complexity. Need empirical testing with real Twining project data during Phase 3 to calibrate pagination limits.
- **Resolution:** Start with conservative limit (100 entities, depth=2), add performance monitoring in Phase 3, adjust based on actual metrics.

**Embedding availability detection:** Current codebase has graceful ONNX fallback, but exact mechanism for detecting availability not documented in research.
- **Resolution:** Review src/embeddings/ implementation during Phase 2 planning to expose `isAvailable()` method for HTTP endpoints.

**Optimal polling interval:** Research suggests 2-5s range, but exact value depends on file I/O latency and typical update frequency.
- **Resolution:** Start with 5s (conservative), instrument with metrics in Phase 2, tune based on p95 latency + user feedback.

**Dashboard discoverability:** Research doesn't address how users discover dashboard URL after server starts.
- **Resolution:** Log to stderr on startup: `Dashboard: http://localhost:24282` (Phase 1). Serena MCP uses same pattern.

## Sources

### Primary (HIGH confidence)
- [STACK.md](STACK.md) — Technology stack research with verified versions and performance benchmarks
- [FEATURES.md](FEATURES.md) — Feature landscape analysis based on developer tool patterns
- [ARCHITECTURE.md](ARCHITECTURE.md) — Dual-transport architecture patterns with Serena MCP reference
- [PITFALLS.md](PITFALLS.md) — Critical pitfalls with prevention strategies from documented incidents

### Secondary (MEDIUM confidence)
- MCP Specification (stdio transport) — Newline-delimited JSON-RPC, no embedded newlines
- Serena MCP Documentation — Dashboard on port 24282, localhost-only, default enabled
- Cytoscape.js GitHub Issues — Performance optimization flags, memory consumption patterns
- Redux DevTools / React DevTools — UI patterns for time-travel, tree view, detail inspector

### Tertiary (LOW confidence)
- TechEmpower benchmarks (Express vs native http) — Performance claims validated but environment-specific
- Community examples (vanilla JS dashboards) — No-build pattern adoption trend, needs validation

---
*Research completed: 2026-02-16*
*Ready for roadmap: yes*
