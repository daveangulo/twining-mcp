# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-17)

**Core value:** Agents share *why* decisions were made, not just *what* was done -- eliminating information silos across context windows.
**Current focus:** Phase 10 in progress (Visualizations and Polish) -- Plan 01 complete

## Current Position

Phase: 10 of 10 (Visualizations and Polish)
Plan: 1 of 3 in current phase
Status: In Progress
Last activity: 2026-02-17 -- Completed 10-01 (Foundation: vendor libs, dark mode, view-mode toggles)

Progress: [█████████████████████] 96% (21/~23 plans, 9 phases + 1 plan complete)

## Performance Metrics

**Velocity:**
- Total plans completed: 21 (6 v1 + 6 v1.1 + 9 v1.2)
- v1.1 execution time: ~19min (6 plans, 13 tasks)

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. Foundation | 2 | -- | -- |
| 2. Intelligence | 2 | -- | -- |
| 3. Graph + Lifecycle | 2 | -- | -- |
| 4. Git Commit Linking | 2/2 | 5min | 2.5min |
| 5. GSD Bridge + Serena | 2/2 | 7min | 3.5min |
| 6. Search + Export | 2/2 | 7min | 3.5min |
| 7. HTTP Server Foundation | 3/3 | 8min | 2.7min |
| 8. Observability Dashboard | 2/2 | 6min | 3min |
| 9. Search and Filter | 2/2 | 7min | 3.5min |
| 10. Visualizations & Polish | 1/3 | 4min | 4min |

*Updated after each plan completion*

## Accumulated Context

### Decisions

All v1 and v1.1 decisions archived in PROJECT.md Key Decisions table with outcomes.
- Embedded HTTP server (Serena-style): in-process daemon, vanilla HTML/JS, minimal deps -- COMPLETE
- Direct fs calls in DecisionEngine for STATE.md sync -- deliberate exception to storage-layer convention
- Embedded HTTP dashboard using native Node.js http module, vanilla HTML/JS, cytoscape.js for graph, vis-timeline for timeline
- Use raw URL path parsing instead of new URL() to preserve path traversal detection in static file serving
- Read actual bound port from server.address() to support OS-assigned ports (port 0)
- Fire-and-forget dashboard startup -- startDashboard().catch() never blocks MCP stdio transport
- Dynamic import('open') for browser auto-open -- optional at runtime, non-fatal on failure
- API handler runs before health check and static files in request pipeline
- Store instances created once in factory closure, not per-request
- Uninitialized state checked via fs.existsSync, dashboard never calls ensureInitialized
- All user-provided content rendered via textContent (never innerHTML) to prevent XSS
- Polling guard prevents duplicate timers; selected items tracked by ID for refresh stability
- Lazy engine initialization in API routes to prevent IndexManager side effects on uninitialized projects
- Fixed relevance 0.5 for graph entities in unified search (GraphEngine has no relevance scoring)
- Search bar placed between nav tabs and main content for always-visible access
- Global scope filter uses bi-directional prefix matching for intuitive scope narrowing
- Graph entity relations shown in detail panel with clickable source/target IDs
- Vendored visualization libraries committed to git for offline/airgapped support
- View-mode toggles within existing tabs rather than separate tabs for Decisions/Graph
- Dark mode uses data-theme attribute on html element for CSS cascade propagation

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-17
Stopped at: Completed 10-01-PLAN.md (Foundation: vendor libs, dark mode, view-mode toggles)
Resume file: None
Next: 10-02-PLAN.md (Timeline Visualization)
