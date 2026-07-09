# Dashboard Scale Redesign — Design Spec

**Date:** 2026-07-09
**Status:** Approved by Dave (Approach B: scale-native redesign)
**Problem:** Projects with 1000s of decisions and blackboard entries make the dashboard's graphical views (graph, timeline) unusable, and at that scale the visual interfaces are the primary interface — line-by-line reading is not viable.

## Context: why the current dashboard fails at scale

Confirmed by code inspection and live browser inspection (2026-07-09):

1. **API ships full datasets.** `/api/blackboard`, `/api/decisions`, `/api/graph` (src/dashboard/api-routes.ts) return every record with no pagination, filtering, or aggregation. The frontend re-fetches the active tab's entire dataset on every poll tick.
2. **Graph renders everything.** `buildGraphElements()` (app.js) feeds all entities + relations into cytoscape's animated `cose` force layout. Already an unreadable hairball at 425 entities; superlinear layout cost freezes at 5k.
3. **Timeline renders one DOM item per decision.** vis-timeline with `stack: true` is a wall of overlapping boxes at 203 decisions and has no aggregation mode.
4. **Lists paginate client-side** but the full dataset still ships every poll.

No frontend idiom survives the current data contract; no per-record visual idiom survives 1000s of records. Both must change.

## Requirements (user-confirmed)

- **Jobs to serve (all four, first-class):**
  1. Orient on recent activity ("what happened while I wasn't watching")
  2. Decision archaeology ("why is X the way it is; what constrains this area; what superseded what")
  3. Structure & hotspots ("which areas have the most decisions/warnings/churn; how do subsystems relate")
  4. Health/hygiene monitoring ("stale decisions, unresolved warnings, orphans; is coordination state healthy")
- **Scale envelope:** ~5k records per store (decisions, blackboard entries, graph entities). The client may hold a *compact index* in memory; it must never hold or render full datasets.
- **Tech stack:** no hard constraint; chosen on merits (see Decisions).

## Approach

Rebuild the three surfaces that structurally cannot scale (timeline, graph, lists) around scale-first idioms, on top of a new server-side query layer. Leave healthy surfaces (Stats, Search, Agents, theming) untouched.

### Rejected alternatives

- **Conservative retrofit** (keep vis-timeline/cytoscape, add caps/clustering): both libraries lack aggregation modes; result would be "less broken," not good, and revisited within months.
- **Full framework rewrite** (Svelte/React + build step, WebGL graph): rewrites all 7 tabs to fix 3, adds a build toolchain to a zero-config npm package, risks regressions in healthy surfaces.

## 1. Data contract (server)

New endpoints in `src/dashboard/api-routes.ts` (or a new module it delegates to). All **additive** — existing endpoints remain for tests/compat; the frontend migrates off them.

### 1.1 Compact index

`GET /api/index?since=<iso>`

Returns one row per blackboard entry and decision:

```json
{
  "rows": [
    { "id": "...", "kind": "decision|blackboard", "timestamp": "...",
      "entry_type": "finding|status|warning|need|decision",
      "scope": "src/dashboard/", "status": "active|provisional|superseded|overridden",
      "domain": "architecture", "confidence": "high|medium|low",
      "tags": ["..."], "summary": "first ~120 chars" }
  ],
  "total_counts": { "blackboard": 240, "decisions": 203 },
  "generated_at": "..."
}
```

- Without `since`: full index (~200KB gzipped at 5k+5k; enable gzip if not already).
- With `since`: only rows with `timestamp > since` (delta polling). `total_counts` always reflects the full store — the client compares against its own counts and triggers a full refetch on mismatch (covers archival/mutation/supersession invisible to a timestamp delta).
- Decision status *changes* (e.g. active → superseded) must be visible to delta polling. Decision criterion at implementation time: if the store tracks an `updated_at`, filter on it; if not, include decisions whose status differs from the index snapshot via a cheap version counter, or accept full-refetch-on-count-mismatch as the mechanism and document it.
- Field values not present on a record kind are omitted (blackboard rows have no `status`/`confidence`).

### 1.2 Detail

- `GET /api/decisions/:id` — exists, unchanged.
- `GET /api/blackboard/:id` — **new**; full entry body (currently the list payload is the only source).

### 1.3 Graph

- `GET /api/graph/summary` — aggregated meta-graph:
  ```json
  {
    "groups": [ { "type": "file", "count": 192 } ],
    "group_edges": [ { "source_type": "file", "target_type": "function", "relation_counts": { "contains": 40 }, "total": 57 } ],
    "hubs": [ { "id": "...", "name": "...", "type": "...", "degree": 31 } ],
    "orphan_count": 12,
    "entity_count": 425, "relation_count": 905
  }
  ```
  Hubs = top ~20 by degree.
- `GET /api/graph/entities?type=file&sort=degree&offset=0&limit=50&q=substr` — paged entity list for a group (drill level 1). Returns id, name, type, degree.
- `GET /api/graph/neighborhood?id=<entity>&depth=1|2&limit=150` — ego network: entities + relations within `depth` of the anchor, breadth-capped **per neighbor type** with overflow counts:
  ```json
  { "anchor": "...", "entities": [...], "relations": [...],
    "overflow": [ { "from": "<node id>", "type": "file", "omitted": 34 } ] }
  ```
  Deterministic ordering (degree desc, then name) so paging in "+34 more" is stable. `404` if the anchor doesn't exist.

### 1.4 Health

`GET /api/health-report` — reuses existing engines (`src/engine/staleness.ts`, analytics engine):

```json
{
  "stale_decisions": [ { "id", "summary", "scope", "staleness_score", "age_days" } ],
  "unresolved_warnings": [ { "id", "summary", "scope", "age_days" } ],
  "superseded_chains": [ { "head_id", "length", "summary" } ],
  "orphan_entities": { "count": 12, "sample": [ { "id", "name", "type" } ] },
  "unacknowledged_handoffs": [ { "id", "summary", "age_days" } ]
}
```

Each list capped (~50) and sorted by severity/age.

### 1.5 Polling

- Poll `/api/status` (cheap counts) on the existing interval.
- If counts/last_activity changed: fetch `/api/index?since=<last row ts>` and merge; on count mismatch after merge, full index refetch.
- `/api/graph/summary` refreshed only while the Graph tab is active and status indicates graph counts changed.

## 2. Timeline → zoomable density timeline

Replaces vis-timeline on the Decisions tab (and the vendored lib is deleted).

- **Custom canvas component** (`density-timeline.js`): x = time, stacked bar/area histogram of counts per bucket, colored by domain or status (user toggle).
- **Adaptive bucketing:** bucket granularity derives from visible span (year → month → week → day → hour), targeting ~60–120 buckets on screen.
- **Semantic zoom:** when visible record count < ~150, switch from bars to individual selectable lozenges (colored by status; superseded struck through as today).
- **Interactions:** wheel/pinch zoom centered on cursor, drag to pan, brush-select a range. Selection and visible range drive a synced virtualized list below the canvas (shared list component, §4). Click a lozenge → decision detail panel (existing renderer).
- **Data source:** client-side index — bucketing is an in-memory pass; domain/status/scope filters apply instantly.
- **Rendering budget:** one canvas redraw per interaction frame via `requestAnimationFrame`; no per-record DOM.
- Existing toolbar (zoom in/out, fit, today) is preserved against the new component; domain filter chips preserved.

## 3. Graph → drill-down explorer

The render-all mode is **deleted**. Cytoscape remains as renderer (never fed more than ~200 elements; layout switches to `concentric`/`fcose` at these sizes — cheap and stable).

- **Level 0 — Overview:** meta-graph from `/api/graph/summary`. One node per entity type, sized by count; edge width = relation volume. Side panel: top hubs (clickable → ego view), orphan count (clickable → health), totals.
- **Level 1 — Entity list:** clicking a type node opens a searchable, paged side-panel list (`/api/graph/entities`), sorted by degree.
- **Level 2 — Ego explorer:** selecting any entity (list, hubs, search results, entity links in detail panels) loads `/api/graph/neighborhood`. Anchor centered; neighbors grouped; overflow chips ("+34 files") page in more nodes on click, still under the visible cap — paging in evicts lowest-degree currently-unpinned nodes if needed. Tapping a node re-anchors the ego view; a breadcrumb trail (anchor history) supports back-navigation.
- **Table view** of the Graph tab remains, backed by the paged entity list endpoint instead of the full dataset.

## 4. Lists → shared virtualized faceted component

One component (`list-view.js`) instantiated for Blackboard, Decisions (table view), and the timeline's synced list:

- **Windowed rendering:** only visible rows (+ small overscan) exist in the DOM; scrollbar reflects true count. No pagination buttons.
- **Facet bar (sticky):** type, status, domain, confidence, tags, date range — each option shows a live count computed from the client index; multi-select within a facet, AND across facets.
- **Instant text filter:** substring match over index summaries (semantic search remains the Search tab's job).
- **Day-group headers** while scrolling (sticky).
- **Detail on select:** fetch full body via detail endpoints into the existing detail panel renderers.
- Sorting: timestamp (default desc) plus existing sortable columns.

## 5. Health panel & scope navigation

- **Health section** at the top of the Insights tab (no 8th tab): cards for stale decisions, unresolved warnings (age-sorted), longest superseded chains, orphaned entities, unacknowledged handoffs — driven by `/api/health-report`. Each card deep-links to the relevant pre-filtered view via URL hash.
- **Scope breadcrumb:** replaces the free-text scope input. Project root → child scope segments, each level a dropdown of children with record counts (computed from the client index by path-prefix). Every view (lists, timeline, graph entity list where scopes exist, health) respects the active scope. Free-text entry remains available inside the dropdown for power use.
- **URL hash routing:** `#tab/…` encodes tab, scope, facet filters, selected record, timeline range, and graph anchor. Shareable; survives reload; back/forward work.

## 6. Frontend code structure

`app.js` (3,454 lines) is split into native ES modules — no build step (`<script type="module">`, fine for the localhost-only dashboard):

```
src/dashboard/public/js/
  app.js              // orchestrator: tabs, polling, routing
  index-store.js      // compact index: fetch, delta merge, facet counts, scope rollups, subscriptions
  list-view.js        // virtualized faceted list (shared)
  density-timeline.js // canvas timeline
  graph-view.js       // overview / entity list / ego explorer
  health.js           // health cards
  detail-renderers.js // existing detail panel code, extracted
  util.js             // el/debounce/format helpers, extracted
```

Untouched: Stats, Search, Agents tabs; theming; visual design language; `style.css` gains new component styles only. vis-timeline vendor files deleted; cytoscape stays.

## 7. Error handling

- **Index fetch failure:** existing connection banner + retry with backoff; UI keeps last good index.
- **Delta inconsistency:** count mismatch after merge → single full refetch (no retry loop; if the full fetch also mismatches, show stale-data notice).
- **Neighborhood 404** (entity pruned between views): toast + return to overview.
- **Empty/degenerate data:** timeline guards for empty index and single-timestamp domains; graph overview renders an empty state (existing pattern).
- **Large summaries/tags:** index builder truncates defensively server-side.

## 8. Testing & verification

- **Seed fixture generator** (`scripts/seed-scale-fixture.ts` or `.js`): writes a synthetic `.twining/` with ~5k decisions, ~5k blackboard entries, ~5k entities/relations, realistic scope distribution and superseded chains. Used by API tests and manual dev.
- **Server unit tests** (existing `test/dashboard/` vitest pattern): index shape + delta semantics + count-mismatch signal; neighborhood caps/overflow/determinism; graph summary aggregation; health report; blackboard detail endpoint.
- **Frontend verification during development** via Playwright browser against the seeded fixture: bounded DOM node counts in lists, timeline mode switch at the threshold, ego expansion + overflow paging, hash routing round-trip. CI-level Playwright tests deferred (would add a devDependency) — noted as future work.
- **Performance targets:** first paint < 1s at 5k/5k/5k; interactions don't lock the main thread; every view's DOM is O(visible), never O(dataset).

## 9. Decisions & rationale (for the audit trail)

1. **Server query layer is the foundation** — no client idiom survives full-dataset polling. (Recorded in Twining, 2026-07-09.)
2. **Vanilla JS stays, via ES modules; no build step.** The hard parts (canvas timeline, data contract) gain nothing from a framework; a toolchain adds weight to a zero-config npm package. Invalidated if the dashboard grows into a real SPA with heavy shared state.
3. **Client-side compact index** rather than fully server-windowed queries — at the 5k envelope it buys instant facets/scope rollups/timeline bucketing for ~200KB gzipped. Invalidated above ~20–30k records per store; the API shape (delta + counts) leaves room to move windowing server-side later.
4. **vis-timeline removed; cytoscape retained.** vis-timeline cannot aggregate (its core idiom is per-item DOM); cytoscape is only unusable when overfed — capped subgraphs render well.
5. **Health lives in Insights, not a new tab** — keeps tab count stable; health cards deep-link into filtered views, so it's a router, not a destination.
6. **Old endpoints kept** — additive change; tests and any external consumers unaffected.

## 10. Assumptions

- Dashboard API consumers are only the bundled frontend + tests (external consumers unknown but endpoints are kept anyway).
- Modern evergreen browser (localhost dev tool) — ES modules, canvas, `IntersectionObserver` all safe.
- Blackboard entries are immutable post-creation (archival aside); decisions can change status — delta polling design accounts for the latter.
- The staleness engine and analytics engine expose (or can cheaply expose) the per-record data the health report needs.

## 11. Suggested implementation phasing

1. Server query layer + index store + seed fixture (everything else depends on it)
2. Shared virtualized list → Blackboard + Decisions table views
3. Density timeline (replaces vis-timeline)
4. Graph drill-down explorer
5. Health panel, scope breadcrumb, hash routing, polish + scale verification pass
