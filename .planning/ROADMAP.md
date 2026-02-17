# Roadmap: Twining MCP Server

## Milestones

- ✅ **v1** -- Phases 1-3 (shipped 2026-02-17)
- ✅ **v1.1 Integrations + Polish** -- Phases 4-6 (shipped 2026-02-17)
- 🚧 **v1.2 Web Dashboard** -- Phases 7-10 (in progress)

## Phases

<details>
<summary>✅ v1 (Phases 1-3) -- SHIPPED 2026-02-17</summary>

- [x] Phase 1: Foundation + Core Data (2/2 plans) -- completed 2026-02-16
- [x] Phase 2: Intelligence (2/2 plans) -- completed 2026-02-16
- [x] Phase 3: Graph + Lifecycle (2/2 plans) -- completed 2026-02-17

</details>

<details>
<summary>✅ v1.1 Integrations + Polish (Phases 4-6) -- SHIPPED 2026-02-17</summary>

- [x] Phase 4: Git Commit Linking (2/2 plans) -- completed 2026-02-17
- [x] Phase 5: GSD Planning Bridge + Serena Docs (2/2 plans) -- completed 2026-02-17
- [x] Phase 6: Search + Export (2/2 plans) -- completed 2026-02-17

</details>

### v1.2 Web Dashboard (In Progress)

- [ ] **Phase 7: HTTP Server Foundation** - Embedded HTTP server runs alongside MCP stdio without interference
- [ ] **Phase 8: Observability Dashboard** - Browsable data views for all Twining state
- [ ] **Phase 9: Search and Filter** - Free-text and faceted search across all data types
- [ ] **Phase 10: Visualizations and Polish** - Interactive graph/timeline visualizations with dark mode

## Phase Details

### Phase 7: HTTP Server Foundation
**Goal**: Dashboard HTTP server runs alongside MCP stdio without interference
**Depends on**: Phase 6 (v1.1 complete)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, INFRA-06, INFRA-07
**Success Criteria** (what must be TRUE):
  1. User can start twining-mcp and the HTTP dashboard is accessible at localhost:24282
  2. MCP stdio tools continue working identically when the dashboard is enabled
  3. Dashboard serves a static page that loads without errors in the browser
  4. Server handles port conflicts gracefully by trying subsequent ports
  5. Server shuts down cleanly when MCP process exits
**Plans**: 3 plans

Plans:
- [ ] 07-01-PLAN.md -- Core HTTP server module (config, static serving, port retry, health endpoint, tests)
- [ ] 07-02-PLAN.md -- Static assets, MCP lifecycle integration, browser auto-open, graceful shutdown, build pipeline
- [ ] 07-03-PLAN.md -- Gap closure: wire setupDashboardShutdown into MCP lifecycle (INFRA-07)

### Phase 8: Observability Dashboard
**Goal**: User can browse all Twining state through the web dashboard
**Depends on**: Phase 7
**Requirements**: OBS-01, OBS-02, OBS-03, OBS-04, OBS-05, OBS-06, OBS-07
**Success Criteria** (what must be TRUE):
  1. User sees operational stats (entry counts, decision counts, entity counts, last activity) on the landing page
  2. User can browse paginated, sortable lists of blackboard entries, decisions, and graph entities
  3. User can click any item to see its full details in an inspector panel
  4. Dashboard auto-refreshes data without manual reload, and pauses polling when tab is hidden
**Plans**: 2 plans

Plans:
- [ ] 08-01-PLAN.md -- API routes layer (5 JSON endpoints for status, blackboard, decisions, graph)
- [ ] 08-02-PLAN.md -- Dashboard frontend (tab navigation, tables, sorting, pagination, detail inspector, polling with visibility-aware lifecycle)

### Phase 9: Search and Filter
**Goal**: User can find specific entries across all Twining data types
**Depends on**: Phase 8
**Requirements**: SRCH-01, SRCH-02, SRCH-03, SRCH-04, SRCH-05
**Success Criteria** (what must be TRUE):
  1. User can type free text and get results spanning blackboard entries, decisions, and graph entities
  2. User can narrow results using type, status, scope, tags, and date range filters
  3. User can click ID references in detail panels to navigate directly to related entries
  4. User can apply a global scope filter that constrains all dashboard views
**Plans**: 2 plans

Plans:
- [ ] 09-01-PLAN.md -- Unified search API endpoint (engine-based search orchestration across blackboard, decisions, graph)
- [ ] 09-02-PLAN.md -- Search frontend (search bar, filters, Search tab, clickable ID navigation, global scope filter)

### Phase 10: Visualizations and Polish
**Goal**: User can see decisions and graph data as interactive visual representations
**Depends on**: Phase 8
**Requirements**: VIZ-01, VIZ-02, VIZ-03, VIZ-04, VIZ-05, VIZ-06, VIZ-07
**Success Criteria** (what must be TRUE):
  1. User can view decisions on a chronological timeline and click items to see full details
  2. User can view the knowledge graph as an interactive force-directed visualization with zoom, pan, and click-to-expand
  3. Graph nodes are color-coded by entity type and decisions are color-coded by confidence level
  4. Dashboard supports a dark mode theme
**Plans**: TBD

Plans:
- [ ] 10-01: TBD
- [ ] 10-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 7 -> 8 -> 9 -> 10

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation + Core Data | v1 | 2/2 | Complete | 2026-02-16 |
| 2. Intelligence | v1 | 2/2 | Complete | 2026-02-16 |
| 3. Graph + Lifecycle | v1 | 2/2 | Complete | 2026-02-17 |
| 4. Git Commit Linking | v1.1 | 2/2 | Complete | 2026-02-17 |
| 5. GSD Planning Bridge + Serena Docs | v1.1 | 2/2 | Complete | 2026-02-17 |
| 6. Search + Export | v1.1 | 2/2 | Complete | 2026-02-17 |
| 7. HTTP Server Foundation | v1.2 | 0/2 | Planned | - |
| 8. Observability Dashboard | v1.2 | 0/2 | Planned | - |
| 9. Search and Filter | v1.2 | 0/? | Not started | - |
| 10. Visualizations and Polish | v1.2 | 0/? | Not started | - |
