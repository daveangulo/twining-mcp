# Phase 8: Observability Dashboard - Research

**Researched:** 2026-02-16
**Domain:** Vanilla JS dashboard with JSON API endpoints on existing HTTP server
**Confidence:** HIGH

## Summary

Phase 8 adds the core observability UI to the Twining dashboard: operational stats, paginated/sortable data lists, detail inspector, and auto-refreshing with visibility-aware polling. This builds directly on the Phase 7 HTTP server foundation (`src/dashboard/http-server.ts`) which already serves static files and has a `/api/health` routing pattern.

The implementation requires two layers: (1) server-side API endpoints that read from the existing storage layer (BlackboardStore, DecisionStore, GraphStore), and (2) client-side vanilla JavaScript that fetches data, renders tables, handles sorting/pagination, and manages polling lifecycle. No new npm dependencies are needed -- everything uses the native Node.js `http` module on the server and vanilla DOM APIs on the client.

The critical architectural question is how the HTTP server accesses the stores. Currently `startDashboard(projectRoot)` only receives the project root path. The simplest approach is to have the dashboard create its own read-only store instances from `path.join(projectRoot, '.twining')`, since all stores are just file readers. This avoids coupling the dashboard to the MCP server's store instances and maintains the fire-and-forget startup pattern established in Phase 7.

**Primary recommendation:** Add 4 API routes (`/api/status`, `/api/blackboard`, `/api/decisions`, `/api/graph`) that instantiate stores from projectRoot and return JSON. Build the frontend as vanilla HTML/CSS/JS with hand-rolled sorting, pagination, and a detail inspector panel. Use `document.visibilitychange` to pause/resume polling.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OBS-01 | User can view operational stats at a glance (blackboard entries, active/provisional decisions, graph entities/relations, last activity) | `/api/status` endpoint replicates `twining_status` tool logic; frontend renders stats cards on landing page |
| OBS-02 | User can browse blackboard entries in a paginated list with sortable columns | `/api/blackboard` returns all entries; client-side sorting by timestamp/type/scope, pagination via array slicing |
| OBS-03 | User can browse decisions in a paginated list with sortable columns | `/api/decisions` returns index entries; client-side sorting by timestamp/domain/status/confidence |
| OBS-04 | User can browse knowledge graph entities in a paginated list | `/api/graph` returns entities and relations; client-side pagination for entities list |
| OBS-05 | User can click any entry to see full details in an inspector panel | Inspector panel (right/bottom) shows full JSON detail; for decisions, `/api/decisions/:id` returns full decision object |
| OBS-06 | Dashboard auto-refreshes data via polling (2-5 second interval) | `setInterval` with 3-second default; polls `/api/status` for stats, active tab data endpoint for list views |
| OBS-07 | Polling pauses when dashboard tab is not visible (visibility API) | `document.addEventListener('visibilitychange', ...)` with `document.hidden` check; `clearInterval` on hide, `setInterval` on visible |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:http` | (built-in) | API endpoint handling | Already used by Phase 7 HTTP server; extend `handleRequest` with new routes |
| Vanilla JavaScript | ES2020+ | Client-side rendering, sorting, pagination, polling | Project constraint: no build step, no frameworks. All modern browsers support needed APIs |
| CSS Grid/Flexbox | (built-in) | List + detail panel layout | Master-detail pattern with responsive columns. No CSS library needed |
| Page Visibility API | (built-in) | Pause polling when tab hidden | Baseline support since July 2015; `document.hidden` + `visibilitychange` event |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `BlackboardStore` | (internal) | Read blackboard entries | Instantiate in API handler from `twiningDir` path |
| `DecisionStore` | (internal) | Read decisions and index | Instantiate in API handler from `twiningDir` path |
| `GraphStore` | (internal) | Read entities and relations | Instantiate in API handler from `twiningDir` path |
| `loadConfig()` | (internal) | Read Twining config for thresholds | Archive threshold for status warnings |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Client-side sorting/pagination | Server-side pagination with `?page=1&limit=20` | Server-side avoids sending all data; but datasets are small (<1000 entries), client-side is simpler and avoids pagination state in URL |
| Hand-rolled tables | `sortable` npm package (vanilla JS table sort) | Extra dependency for minimal gain; our tables have known columns, sorting is ~20 lines of JS |
| New store instances per request | Pass stores from `createServer()` to `startDashboard()` | Passing stores couples dashboard lifecycle to MCP server; independent stores are simpler and match fire-and-forget pattern |
| `setInterval` polling | Server-Sent Events (SSE) or WebSocket | SSE/WS add connection management complexity; polling every 3s is sufficient for dev tool observability (per FEATURES.md anti-features analysis) |

**Installation:**
```bash
# No new dependencies needed -- everything is built-in or already in the project
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── dashboard/
│   ├── http-server.ts       # MODIFIED: add API route handling
│   ├── api-routes.ts        # NEW: API endpoint handlers
│   ├── dashboard-config.ts  # EXISTING: unchanged
│   └── public/              # MODIFIED: replace shell with full UI
│       ├── index.html       # Full dashboard HTML with tab navigation
│       ├── style.css         # Extended styles for tables, panels, stats
│       └── app.js           # Full client app: fetch, render, sort, paginate, poll
├── index.ts                 # UNCHANGED
├── server.ts                # UNCHANGED
└── ...existing modules...
```

### Pattern 1: API Route Handler with Store Access
**What:** Create store instances from projectRoot in the API handler module. Each API request reads from files -- no persistent state in the HTTP handler.
**When to use:** All 4 API endpoints.
**Example:**
```typescript
// src/dashboard/api-routes.ts
import http from "node:http";
import path from "node:path";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import { loadConfig } from "../config.js";

export function createApiHandler(projectRoot: string) {
  const twiningDir = path.join(projectRoot, ".twining");

  // Create read-only store instances
  const blackboardStore = new BlackboardStore(twiningDir);
  const decisionStore = new DecisionStore(twiningDir);
  const graphStore = new GraphStore(twiningDir);

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = req.url || "/";

    if (url === "/api/status") {
      const data = await getStatus(twiningDir, blackboardStore, decisionStore, graphStore);
      sendJSON(res, data);
      return true;
    }

    if (url === "/api/blackboard") {
      const { entries, total_count } = await blackboardStore.read();
      sendJSON(res, { entries, total_count });
      return true;
    }

    // ... more routes

    return false; // not handled
  };
}

function sendJSON(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(data));
}
```

### Pattern 2: Master-Detail Layout
**What:** Left/top area shows paginated list; right/bottom area shows detail inspector for selected item.
**When to use:** OBS-02 through OBS-05 (blackboard, decisions, graph lists with detail).
**Example (HTML structure):**
```html
<main>
  <!-- Tab navigation: Stats | Blackboard | Decisions | Graph -->
  <nav class="tabs">...</nav>

  <!-- Content area with master-detail split -->
  <div class="content-area">
    <div class="list-panel">
      <table class="data-table sortable">...</table>
      <div class="pagination">...</div>
    </div>
    <div class="detail-panel" id="detail-panel">
      <p class="placeholder">Select an item to view details</p>
    </div>
  </div>
</main>
```
**CSS pattern:**
```css
.content-area {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 1rem;
  min-height: 0;
}

/* Collapse to stacked on narrow screens */
@media (max-width: 900px) {
  .content-area {
    grid-template-columns: 1fr;
  }
}
```

### Pattern 3: Client-Side Table Sorting
**What:** Click column header to sort ascending/descending. No server round-trip.
**When to use:** OBS-02, OBS-03, OBS-04.
**Example:**
```javascript
var state = {
  data: [],
  sortKey: "timestamp",
  sortDir: "desc",
  page: 1,
  pageSize: 25,
};

function sortData(data, key, dir) {
  return data.slice().sort(function(a, b) {
    var va = a[key] || "";
    var vb = b[key] || "";
    var cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  });
}

function paginate(data, page, pageSize) {
  var start = (page - 1) * pageSize;
  return data.slice(start, start + pageSize);
}

function renderTable(data) {
  var sorted = sortData(data, state.sortKey, state.sortDir);
  var paged = paginate(sorted, state.page, state.pageSize);
  // ... render rows
}
```

### Pattern 4: Polling with Visibility-Aware Lifecycle
**What:** Poll API endpoints on a timer; pause when tab is hidden; resume when visible.
**When to use:** OBS-06, OBS-07.
**Example:**
```javascript
var pollTimer = null;
var POLL_INTERVAL = 3000; // 3 seconds

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshData, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener("visibilitychange", function() {
  if (document.hidden) {
    stopPolling();
  } else {
    refreshData(); // immediate refresh on return
    startPolling();
  }
});

// Start polling on page load
startPolling();
```

### Pattern 5: Tab-Based Navigation (Single Page, No Router)
**What:** Simple tab navigation that shows/hides content sections. No URL routing needed.
**When to use:** Switch between Stats, Blackboard, Decisions, Graph views.
**Example:**
```javascript
function switchTab(tabName) {
  // Hide all tab content
  document.querySelectorAll(".tab-content").forEach(function(el) {
    el.style.display = "none";
  });
  // Show selected tab
  document.getElementById("tab-" + tabName).style.display = "block";
  // Update active tab button
  document.querySelectorAll(".tab-btn").forEach(function(btn) {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  // Fetch data for the active tab
  fetchTabData(tabName);
}
```

### Anti-Patterns to Avoid
- **Creating stores on every request:** Instantiate stores once when creating the API handler, not per-request. Store constructors just compute file paths -- cheap, but no reason to repeat.
- **innerHTML for user data:** Always use `textContent` for user-provided strings (summaries, details) to prevent XSS. Only use `innerHTML` for structural markup with no user content.
- **Polling all endpoints simultaneously:** Only poll the active tab's data endpoint plus `/api/status` for the stats header. Polling all 4 endpoints every 3s wastes I/O.
- **Re-rendering entire DOM on every poll:** Compare timestamps to detect changes. Only re-render if data has actually changed (compare total_count or last_activity).
- **Blocking MCP writes with store reads:** Store reads use `readFileSync` but are fast (JSONL parsing). No locking needed for reads. Writes use `proper-lockfile` and won't conflict with reads.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP routing framework | Express/Fastify/custom router | Simple `if (url === "/api/...")` in handleRequest | Only 5-6 routes total; framework overhead is unjustified |
| Date formatting | Custom date parser | `new Date(timestamp).toLocaleString()` | Built-in browser API, locale-aware |
| JSON response helper | Repeated writeHead+end | Small `sendJSON(res, data)` utility function | DRY pattern, 5 lines |
| Table virtualization | Windowed/virtual scrolling | Simple pagination (25 items/page) | Datasets are small (<1000); virtual scrolling is complex for no benefit |

**Key insight:** The entire dashboard is a read-only viewer for a small dataset (typically <500 entries, <50 decisions, <100 entities). Performance optimization beyond basic pagination is premature. The constraint is developer time, not runtime speed.

## Common Pitfalls

### Pitfall 1: Store Initialization Race Condition
**What goes wrong:** API handler creates store instances before `.twining/` directory exists (e.g., if dashboard starts before first MCP tool call).
**Why it happens:** `ensureInitialized()` is called in `createServer()`, but the dashboard starts independently via `startDashboard()`.
**How to avoid:** Check if `.twining/` directory exists in API handler. Return `{"error": "Twining not initialized. Use an MCP tool first."}` with 503 status if missing. Don't call `ensureInitialized()` from the dashboard -- let MCP handle initialization.
**Warning signs:** 500 errors from API endpoints on fresh project with no `.twining/` directory.

### Pitfall 2: XSS via User Content in Tables
**What goes wrong:** Blackboard summaries or decision rationale containing HTML/JS get executed when rendered.
**Why it happens:** Using `innerHTML` or string concatenation to build table rows with user-provided text.
**How to avoid:** Always use `document.createElement` + `textContent` for user data. Never template user strings into HTML.
**Warning signs:** Broken table layout when entries contain `<` or `>` characters.

### Pitfall 3: Stale Detail Panel After Refresh
**What goes wrong:** User selects an entry, data refreshes, the entry's index changes or entry is deleted, but detail panel still shows old data.
**Why it happens:** Detail panel references data by array index instead of by ID.
**How to avoid:** Store selected item ID, not index. After refresh, look up item by ID in new data. If not found, show "Item no longer exists" message.
**Warning signs:** Detail panel shows wrong item after polling refresh.

### Pitfall 4: Decision Index vs Full Decision Objects
**What goes wrong:** Decision list shows only index fields but detail panel needs full decision (rationale, alternatives, constraints).
**Why it happens:** `DecisionStore.getIndex()` returns lightweight `DecisionIndexEntry` objects, not full `Decision` objects.
**How to avoid:** List view uses index data (fast). When user clicks a decision, make a second API call to `/api/decisions/:id` to fetch the full decision object. This avoids loading all full decisions just for the list view.
**Warning signs:** Missing fields in decision detail panel (rationale, alternatives, context).

### Pitfall 5: Polling Timer Leak on Tab Switch
**What goes wrong:** Multiple polling timers accumulate if `startPolling` is called without checking for existing timer.
**Why it happens:** `visibilitychange` fires and code starts a new interval without clearing the old one.
**How to avoid:** Always check `if (pollTimer) return;` at the start of `startPolling()`. Always `clearInterval` before setting a new timer.
**Warning signs:** API requests accelerate over time (2x, 3x, 4x frequency).

### Pitfall 6: Large Detail Content Overflowing
**What goes wrong:** Decision rationale or entry detail text is very long, pushing the detail panel beyond viewport.
**Why it happens:** No `overflow-y: auto` on the detail panel.
**How to avoid:** Set detail panel to `overflow-y: auto; max-height: calc(100vh - header)`. Use `word-break: break-word` for long unbroken strings.
**Warning signs:** Scrollbar appears on entire page instead of within detail panel.

## Code Examples

### API Status Endpoint (mirrors twining_status tool)
```typescript
// Source: Existing lifecycle-tools.ts twining_status implementation
async function getStatus(
  twiningDir: string,
  blackboardStore: BlackboardStore,
  decisionStore: DecisionStore,
  graphStore: GraphStore,
): Promise<object> {
  const { total_count: blackboard_entries } = await blackboardStore.read();
  const index = await decisionStore.getIndex();
  const active_decisions = index.filter(e => e.status === "active").length;
  const provisional_decisions = index.filter(e => e.status === "provisional").length;
  const entities = await graphStore.getEntities();
  const relations = await graphStore.getRelations();

  const recentEntries = await blackboardStore.recent(1);
  const lastBBActivity = recentEntries.length > 0 ? recentEntries[0].timestamp : null;
  const lastDecisionActivity = index.length > 0
    ? index.reduce((latest, e) => e.timestamp > latest ? e.timestamp : latest, index[0].timestamp)
    : null;

  let last_activity = "none";
  if (lastBBActivity && lastDecisionActivity) {
    last_activity = lastBBActivity > lastDecisionActivity ? lastBBActivity : lastDecisionActivity;
  } else if (lastBBActivity) {
    last_activity = lastBBActivity;
  } else if (lastDecisionActivity) {
    last_activity = lastDecisionActivity;
  }

  return {
    blackboard_entries,
    active_decisions,
    provisional_decisions,
    graph_entities: entities.length,
    graph_relations: relations.length,
    last_activity,
  };
}
```

### Client-Side Table Rendering (vanilla JS)
```javascript
// Source: Vanilla JS best practices, verified against MDN DOM API docs
function renderTableRows(container, items, columns) {
  var tbody = container.querySelector("tbody");
  tbody.innerHTML = ""; // safe: no user content in structural HTML

  items.forEach(function(item) {
    var tr = document.createElement("tr");
    tr.dataset.id = item.id;
    tr.addEventListener("click", function() { showDetail(item.id); });

    columns.forEach(function(col) {
      var td = document.createElement("td");
      td.textContent = item[col.key] || ""; // textContent prevents XSS
      if (col.className) td.className = col.className;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}
```

### Pagination Controls
```javascript
function renderPagination(container, totalItems, page, pageSize) {
  var totalPages = Math.ceil(totalItems / pageSize);
  container.innerHTML = ""; // structural only

  var info = document.createElement("span");
  info.textContent = "Page " + page + " of " + totalPages + " (" + totalItems + " items)";
  container.appendChild(info);

  var prevBtn = document.createElement("button");
  prevBtn.textContent = "Previous";
  prevBtn.disabled = page <= 1;
  prevBtn.addEventListener("click", function() { goToPage(page - 1); });
  container.appendChild(prevBtn);

  var nextBtn = document.createElement("button");
  nextBtn.textContent = "Next";
  nextBtn.disabled = page >= totalPages;
  nextBtn.addEventListener("click", function() { goToPage(page + 1); });
  container.appendChild(nextBtn);
}
```

### Page Visibility API for Polling Control
```javascript
// Source: MDN Page Visibility API documentation
// https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
var pollTimer = null;
var POLL_INTERVAL = 3000;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshData, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener("visibilitychange", function() {
  if (document.hidden) {
    stopPolling();
  } else {
    refreshData(); // immediate fetch on return
    startPolling();
  }
});
```

### Detail Inspector Panel
```javascript
function showDetail(id) {
  var panel = document.getElementById("detail-panel");
  panel.innerHTML = '<p class="loading">Loading...</p>';

  // Determine type from current tab
  var endpoint = getDetailEndpoint(id);

  fetch(endpoint)
    .then(function(res) { return res.json(); })
    .then(function(data) {
      renderDetailContent(panel, data);
    })
    .catch(function(err) {
      panel.innerHTML = "";
      var errP = document.createElement("p");
      errP.className = "error";
      errP.textContent = "Failed to load details: " + err.message;
      panel.appendChild(errP);
    });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| React/Vue SPA for simple dashboards | Vanilla JS for small, self-contained UIs | 2023+ trend | Zero build step, zero bundle size, faster cold load; appropriate for <2000 LOC client code |
| jQuery for DOM manipulation | Native DOM APIs (createElement, textContent, classList) | 2018+ | jQuery adds 85KB for features now built into every browser |
| XHR for data fetching | `fetch()` API | 2015+ baseline | Cleaner API, Promise-based, no polyfill needed |
| WebSocket for real-time | Polling for developer tools | Ongoing | WebSocket justified for chat/gaming; polling is simpler and sufficient for 3-5s refresh |
| Server-rendered pages | Client-rendered SPA-like with JSON APIs | 2020+ | Separates data from presentation; enables auto-refresh without full page reload |

**Deprecated/outdated:**
- `XMLHttpRequest` -- use `fetch()` instead
- jQuery selectors -- use `document.querySelector()` / `querySelectorAll()`
- `document.write()` -- never appropriate for SPA-style rendering
- CSS floats for layout -- use CSS Grid or Flexbox

## Open Questions

1. **Store instance sharing vs independent creation**
   - What we know: Creating separate store instances from projectRoot works because stores are just file path wrappers. Reads don't require locking.
   - What's unclear: Whether creating stores per-request vs once at API handler creation has measurable overhead.
   - Recommendation: Create stores once at API handler initialization (when `createApiHandler(projectRoot)` is called). This is both simpler and avoids any constructor overhead. The stores hold no mutable state -- they just read files each time.

2. **Decision detail fetch strategy**
   - What we know: Decision index is lightweight (summary, status, scope). Full decisions include rationale, alternatives, context (~1-5KB each).
   - What's unclear: Whether to include full decisions in the list endpoint or fetch individually.
   - Recommendation: List endpoint returns index entries only. Add `/api/decisions/:id` that calls `decisionStore.get(id)` to return the full decision. This keeps the list response fast and avoids sending unnecessary data. The detail fetch is triggered by user click -- acceptable latency (single file read, <5ms).

3. **Blackboard entry detail vs inline**
   - What we know: Blackboard entries have `summary` (short) and `detail` (potentially long). The list shows summary.
   - What's unclear: Whether detail is large enough to warrant a separate fetch.
   - Recommendation: Include all fields in the `/api/blackboard` response since the data format is JSONL and entries are typically small. The detail panel reads from the already-fetched data array. No separate detail endpoint needed for blackboard entries.

4. **How to handle empty/uninitialized state**
   - What we know: Dashboard may start before any MCP tool has been called (no `.twining/` directory yet).
   - What's unclear: Best UX for this state.
   - Recommendation: API endpoints check for `.twining/` directory existence. If missing, return empty arrays with a `{ initialized: false }` flag. Frontend shows a friendly message: "No data yet. Twining will populate as agents use MCP tools."

5. **API route registration pattern**
   - What we know: Phase 7 has a single `handleRequest` function in `http-server.ts` with an inline `/api/health` check.
   - What's unclear: Whether to extend inline or extract to a separate module.
   - Recommendation: Extract API routes to `src/dashboard/api-routes.ts` as a function that returns an async handler. `handleRequest` in `http-server.ts` calls the API handler first, falls through to static file serving. This keeps `http-server.ts` focused on HTTP mechanics and `api-routes.ts` on data access.

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/storage/blackboard-store.ts`, `src/storage/decision-store.ts`, `src/storage/graph-store.ts` -- verified store APIs and data models
- Existing codebase: `src/dashboard/http-server.ts` -- verified Phase 7 HTTP server foundation, routing pattern, static file serving
- Existing codebase: `src/tools/lifecycle-tools.ts` -- verified `twining_status` implementation that API status endpoint will mirror
- Existing codebase: `src/utils/types.ts` -- verified all data type interfaces (BlackboardEntry, Decision, Entity, Relation, DecisionIndexEntry)
- [MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) -- verified `document.hidden`, `visibilitychange` event, browser compatibility (baseline since July 2015)
- [MDN Document.visibilityState](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilityState) -- verified `visible`/`hidden` states

### Secondary (MEDIUM confidence)
- `.planning/research/FEATURES.md` -- prior feature research establishing MVP definition, anti-features (no WebSocket, no inline editing), competitive analysis
- `.planning/phases/07-http-server-foundation/07-RESEARCH.md` -- Phase 7 research establishing architecture patterns, port management, stdio safety
- `.planning/phases/07-http-server-foundation/07-VERIFICATION.md` -- verified Phase 7 completion with all 10/10 truths passing
- [Building Table Sorting and Pagination in JavaScript](https://www.raymondcamden.com/2022/03/14/building-table-sorting-and-pagination-in-javascript) -- vanilla JS table patterns

### Tertiary (LOW confidence)
- General web search results on vanilla JS dashboard patterns -- common knowledge, not requiring specific verification
- CSS Grid layout patterns for master-detail UIs -- well-established browser feature, verified against MDN docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- No new dependencies; all built-in browser APIs and existing project code
- Architecture: HIGH -- Direct extension of Phase 7 patterns; store APIs already verified and tested
- Pitfalls: HIGH -- Primary pitfalls (XSS, stale detail, timer leak) are well-understood browser development issues with known solutions; store race condition identified from codebase analysis
- Frontend patterns: HIGH -- Vanilla JS table sorting, pagination, and polling are straightforward DOM API usage; Page Visibility API is baseline since 2015

**Research date:** 2026-02-16
**Valid until:** 2026-04-16 (stable domain; browser APIs and Node.js http module are mature)
