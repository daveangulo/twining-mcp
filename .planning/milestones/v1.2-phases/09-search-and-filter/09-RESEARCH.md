# Phase 9: Search and Filter - Research

**Researched:** 2026-02-17
**Domain:** Cross-type search, faceted filtering, and navigation in vanilla JS dashboard
**Confidence:** HIGH

## Summary

Phase 9 adds search and filtering capabilities to the Twining dashboard built in Phases 7-8. There are two distinct concerns: (1) a unified search API that searches across all three data types (blackboard entries, decisions, graph entities) with both keyword and semantic modes, and (2) frontend UI components for the search bar, filter controls, clickable ID references, and a global scope filter.

The backend already has strong search primitives. `BlackboardStore.read()` supports filtering by entry_types, tags, scope, and since. `DecisionEngine.searchDecisions()` supports keyword/semantic search with domain, status, and confidence filters. `GraphEngine.query()` does substring matching on entity names and properties. The dashboard API layer (`api-routes.ts`) currently serves raw data endpoints. The search phase needs to either (a) add a unified `/api/search` endpoint that orchestrates all three store searches, or (b) have the frontend call existing per-type endpoints and merge results client-side.

The semantic search path (SRCH-03) is the most complex requirement. The existing `SearchEngine` class in `src/embeddings/search.ts` already supports both ONNX-powered semantic search and keyword fallback. For the dashboard, the simplest approach is a server-side `/api/search` endpoint that uses the existing engine infrastructure. However, this means the API route handler needs access to the embedding layer, not just the raw stores. This is a meaningful architectural change from Phase 8's pattern of creating independent store instances.

**Primary recommendation:** Add a single `/api/search` endpoint with query params for text, type filters, status, scope, tags, date range. Server-side, orchestrate BlackboardEngine.query(), DecisionEngine.searchDecisions(), and GraphEngine.query() and merge results. For the frontend, add a search bar above the tab content area, filter dropdowns/inputs, clickable IDs in detail panels, and a persistent global scope filter in the header. Use URL query parameters to track search/filter state for shareable links.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SRCH-01 | User can search across blackboard entries, decisions, and graph entities with free text | `/api/search` endpoint orchestrates `BlackboardEngine.query()`, `DecisionEngine.searchDecisions()`, and `GraphEngine.query()` to return unified results across all types |
| SRCH-02 | User can filter results by entry type, status, scope, tags, and date range | Query parameters on `/api/search` for `types`, `status`, `scope`, `tags`, `since`, `until`; frontend filter bar with dropdowns and date inputs |
| SRCH-03 | User can use semantic search (ONNX embeddings) for relevance-ranked results | Existing `SearchEngine` class already handles both ONNX-based cosine similarity and keyword fallback; `/api/search` response includes `fallback_mode` flag to show user which mode is active |
| SRCH-04 | User can click ID references in detail panels to navigate to related entries | Render ULID-like strings in `relates_to`, `depends_on`, `supersedes`, `source`, `target` fields as clickable links; click navigates to correct tab and selects the referenced item |
| SRCH-05 | User can apply a global scope filter that affects all views | Persistent scope input in the header; client-side filtering applied to all data before rendering; passes scope as query param to API endpoints for server-side pre-filtering |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:http` | (built-in) | Search API endpoint | Extends existing Phase 8 API route handler pattern |
| `node:url` | (built-in) | Parse query parameters from search URLs | `URL` constructor + `searchParams` for clean param parsing |
| Vanilla JavaScript | ES2020+ | Search UI components, filter controls, navigation | Project constraint: no build step, no frameworks |
| `BlackboardEngine` | (internal) | Blackboard text search with semantic/keyword fallback | Already has `query()` method with embedding support |
| `DecisionEngine` | (internal) | Decision search with filters | Already has `searchDecisions()` with domain/status/confidence filters |
| `GraphEngine` | (internal) | Entity substring search | Already has `query()` method with type filtering |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `SearchEngine` | (internal) | Orchestrates embedding-based and keyword-based search | Used by BlackboardEngine.query() and DecisionEngine.searchDecisions() internally |
| `Embedder` | (internal) | Generates query embeddings for semantic search | Lazy-loaded; fallback to keyword search if ONNX unavailable |
| `IndexManager` | (internal) | Reads embedding indexes for cosine similarity | Read-only access for search; no writes needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Server-side unified search endpoint | Client-side parallel fetch + merge | Client-side is simpler but cannot do server-side semantic search (SRCH-03 requires server-side ONNX). Server-side also avoids sending all raw data over HTTP. |
| Engine instances in API handler | Raw store instances (Phase 8 pattern) | Engines add embedding/search capability that stores lack. Requires changing API handler factory to accept engines or create them. Necessary for SRCH-03. |
| URL query params for filter state | In-memory state only | URL params enable shareable/bookmarkable search URLs and browser back/forward navigation. Minimal extra effort. |
| Debounced live search | Explicit search button | Debounced search is more responsive; 300ms debounce prevents excessive API calls while typing |
| Separate search results tab | Inline results in existing tabs | A dedicated search results view is cleaner when results span multiple types. Tab-specific filtering stays within existing tabs. |

**Installation:**
```bash
# No new dependencies needed -- everything uses existing internal modules
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  dashboard/
    api-routes.ts       # MODIFIED: add /api/search endpoint, accept engines
    http-server.ts      # MODIFIED: pass engines to createApiHandler
    dashboard-config.ts # UNCHANGED
    public/
      index.html        # MODIFIED: add search bar, filter controls, global scope, search tab
      style.css         # MODIFIED: add search UI styles
      app.js            # MODIFIED: add search logic, ID navigation, global scope filter
test/
  dashboard/
    api-routes.test.ts  # MODIFIED: add search endpoint tests
```

### Pattern 1: Unified Search API Endpoint
**What:** A single `/api/search?q=text&types=blackboard,decisions&...` endpoint that queries all three data stores and returns merged, relevance-ranked results.
**When to use:** SRCH-01, SRCH-02, SRCH-03.
**Key design decisions:**
- Server-side search orchestration (not client-side) because SRCH-03 requires the ONNX embedding pipeline which only runs in Node.js
- Parse query parameters using the `URL` constructor (consistent with no-external-deps constraint)
- Return results grouped by type with a unified relevance score for cross-type ranking
- Include `fallback_mode: boolean` to indicate whether semantic or keyword search was used

**Example:**
```typescript
// GET /api/search?q=JWT+auth&types=blackboard,decisions&scope=src/auth/&status=active&limit=20

// Response:
{
  query: "JWT auth",
  results: [
    { type: "decision", id: "01HX...", summary: "Use JWT for auth", relevance: 0.92, ... },
    { type: "blackboard", id: "01HY...", summary: "Found JWT library issue", relevance: 0.85, ... },
    { type: "entity", id: "01HZ...", name: "JwtMiddleware", entity_type: "class", relevance: 0.78, ... }
  ],
  total: 15,
  fallback_mode: false
}
```

### Pattern 2: Engine Injection into API Handler
**What:** Modify `createApiHandler` to accept engine instances (or a factory that creates them) instead of creating raw stores. This gives the search endpoint access to the full search pipeline including embeddings.
**When to use:** Required for SRCH-03 (semantic search).

There are two approaches:

**Option A: Pass engines directly.**
```typescript
export function createApiHandler(
  projectRoot: string,
  options?: {
    blackboardEngine?: BlackboardEngine;
    decisionEngine?: DecisionEngine;
    graphEngine?: GraphEngine;
  }
): (req, res) => Promise<boolean>
```
Pros: Clean, testable. Cons: Requires wiring from `index.ts` where both MCP server and dashboard are created.

**Option B: Create engines in the API handler.**
```typescript
export function createApiHandler(projectRoot: string): ... {
  const twiningDir = path.join(projectRoot, ".twining");
  // Create stores (existing)
  const blackboardStore = new BlackboardStore(twiningDir);
  // Create embedding layer (new)
  const embedder = Embedder.getInstance(twiningDir);
  const indexManager = new IndexManager(twiningDir);
  const searchEngine = new SearchEngine(embedder, indexManager);
  // Create engines (new)
  const blackboardEngine = new BlackboardEngine(blackboardStore, embedder, indexManager, searchEngine);
  // ...
}
```
Pros: Self-contained, no changes to caller. Cons: Duplicates engine creation (same instances already exist in `createServer`). The `Embedder.getInstance()` singleton pattern mitigates the duplication for the most expensive component.

**Recommendation:** Option B. The Embedder already uses a singleton pattern per twiningDir, so the ONNX model is loaded at most once. Store instances are cheap file-path wrappers. This preserves the fire-and-forget dashboard startup pattern from Phase 7/8 and avoids threading engine references through the startup chain.

### Pattern 3: Clickable ID References
**What:** In detail panels, render ULID-pattern strings in fields like `relates_to`, `depends_on`, `supersedes`, `source`, `target` as clickable links that navigate to the referenced item.
**When to use:** SRCH-04.

**Implementation approach:**
1. Define a function `navigateToId(id)` that:
   - Searches blackboard data for an entry with that ID -> switch to Blackboard tab, select it
   - Searches decisions data for a decision with that ID -> switch to Decisions tab, select it
   - Searches graph data for an entity with that ID -> switch to Graph tab, select it
   - Falls back to "Not found" indicator if ID doesn't match any loaded data
2. In detail renderers (`renderBlackboardDetail`, `renderDecisionDetail`, `renderGraphDetail`), when rendering ID-like values, wrap them in `<a>` or `<span class="clickable-id">` elements with a click handler calling `navigateToId(id)`
3. Style clickable IDs with the accent color and underline to indicate interactivity

**ID detection pattern:** ULIDs are 26-character strings matching `/^[0-9A-Z]{26}$/i`. Scan field values for this pattern.

```javascript
var ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function renderIdValue(container, value) {
  if (ULID_PATTERN.test(value)) {
    var link = el("span", "clickable-id", value);
    link.addEventListener("click", function(e) {
      e.stopPropagation();
      navigateToId(value);
    });
    container.appendChild(link);
  } else {
    container.textContent = value;
  }
}
```

### Pattern 4: Global Scope Filter
**What:** A persistent scope input in the dashboard header that filters all views to entries matching a scope prefix. When set, all tab data is pre-filtered before rendering.
**When to use:** SRCH-05.

**Implementation approach:**
1. Add a text input in the header area: `<input id="global-scope" placeholder="Filter by scope (e.g., src/auth/)...">`
2. Store the scope value in `state.globalScope`
3. In each render function, apply scope prefix filter before sorting/pagination:
   ```javascript
   function applyGlobalScope(data) {
     if (!state.globalScope) return data;
     return data.filter(function(item) {
       var scope = item.scope || "";
       return scope.startsWith(state.globalScope) || state.globalScope.startsWith(scope);
     });
   }
   ```
4. For graph entities (which don't have a direct `scope` field), filter by matching `properties.file` or `properties.scope` values if they contain the scope prefix
5. Debounce the scope input (300ms) to avoid excessive re-renders while typing
6. Visual indicator when scope filter is active (e.g., highlighted border on the input, badge showing "Filtered: src/auth/")

### Pattern 5: Search Results View
**What:** A dedicated search tab or overlay that shows cross-type results when the user performs a free-text search.
**When to use:** SRCH-01.

**Two design options:**

**Option A: New "Search" tab.** Add a fifth tab. When user types in the search bar and presses Enter, switch to the Search tab showing merged results. Each result shows its type badge (blackboard/decision/entity), summary, relevance score, and scope. Clicking a result navigates to the correct tab and selects the item.

**Option B: Overlay panel.** Search bar triggers a dropdown overlay (like a command palette). Results appear in the overlay. Clicking a result navigates to the correct tab. Escape or clicking away dismisses the overlay.

**Recommendation:** Option A (new Search tab). It integrates naturally with the existing tab pattern, allows sorting/pagination of results, and doesn't require overlay z-index management. The search bar can live in the header area (always visible across tabs) and hitting Enter or clicking a search button switches to the Search tab with results.

### Anti-Patterns to Avoid
- **Searching on every keystroke without debounce:** Free-text search triggers a server round-trip for semantic search. Always debounce (300ms minimum) to avoid hammering the API.
- **Loading all data client-side for filtering:** While Phase 8 loads all data, search with semantic scoring must happen server-side (ONNX runs in Node.js). Keep the `/api/search` endpoint for text queries.
- **Losing tab-specific filter state:** The global scope filter should be orthogonal to tab-specific sort/pagination state. Don't reset pagination when scope changes; do reset to page 1 when data set changes.
- **innerHTML for search result highlights:** If highlighting matching terms in results, use DOM manipulation (wrap in `<mark>` elements via createElement), never innerHTML with user text.
- **Blocking the main thread with large searches:** The ONNX embedding generation is async. Ensure the `/api/search` endpoint is fully async and doesn't block other requests.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Semantic search | Custom vector similarity in the API layer | Existing `SearchEngine.searchBlackboard()` and `SearchEngine.searchDecisions()` | Already handles ONNX + keyword fallback, cosine similarity, scoring |
| Query parameter parsing | Manual string splitting | `new URL(url, base).searchParams` | Built-in, handles encoding/escaping correctly |
| Debouncing | Custom timer logic | Simple debounce function (5 lines) | Well-known pattern, but don't import a library for it |
| Date range filtering | Complex date comparison logic | ISO 8601 string comparison (`entry.timestamp >= since`) | ULID timestamps and ISO strings are lexicographically sortable |
| Result relevance merging | Complex scoring algorithm across types | Simple approach: normalize scores 0-1 within each type, interleave by score | Cross-type relevance is inherently approximate; keep it simple |

**Key insight:** The hardest search work (embedding generation, cosine similarity, keyword scoring) already exists in `src/embeddings/search.ts`. Phase 9 is about exposing this through the dashboard, not reimplementing it. The API layer orchestrates existing engines; the frontend provides the UI.

## Common Pitfalls

### Pitfall 1: Engine/Embedder Initialization Cost on First Search
**What goes wrong:** First search request takes 5-10 seconds because ONNX model downloads and initializes lazily.
**Why it happens:** The `Embedder` lazy-loads the ONNX pipeline on first call to `embed()`. If no MCP tool has triggered embedding yet, the dashboard search is the first trigger.
**How to avoid:** Accept the cold-start latency on first search. Show a loading indicator. Include `fallback_mode: true` in the response when embeddings aren't ready so the frontend can show "Keyword search (semantic search loading...)" message. The `Embedder.getInstance()` singleton ensures subsequent searches are fast.
**Warning signs:** First search hangs for seconds, subsequent searches are instant.

### Pitfall 2: Cross-Type Relevance Score Normalization
**What goes wrong:** Blackboard keyword scores and decision semantic scores are on different scales, making merged ranking meaningless.
**Why it happens:** `keywordSearch()` returns log-based TF scores (typically 0.3-1.5). Cosine similarity returns values (0-1). Graph substring match has no relevance score.
**How to avoid:** Normalize scores within each type to 0-1 range before merging. For graph entities (no relevance score), assign a fixed score (e.g., 0.5) for substring matches. Document in the API response that relevance scores are approximate.
**Warning signs:** Graph entities always ranked last, or keyword results dominate over more relevant semantic results.

### Pitfall 3: Global Scope Filter Interacting with Search
**What goes wrong:** User sets global scope to "src/auth/" then searches for "database" -- gets no results because scope filter eliminates all database-related entries.
**Why it happens:** Scope filter and search are applied as AND conditions.
**How to avoid:** Clear decision: global scope filter is always an AND with search. This is the correct behavior (user wants to search within their scope). But make it visually obvious: show "Searching in scope: src/auth/" near the search bar so the user knows to clear the scope if they want broader results.
**Warning signs:** Users confused by empty search results when scope filter is set.

### Pitfall 4: URL State and Back Button
**What goes wrong:** User searches, clicks a result to navigate to a detail view, then clicks browser back button -- nothing happens or page reloads.
**Why it happens:** SPA-style navigation doesn't update browser history.
**How to avoid:** For Phase 9, keep it simple: don't try to sync with browser history. The dashboard is a development tool, not a user-facing app. URL query params for search state are a nice-to-have but not required. Focus on the core search UX. If adding URL params, use `history.replaceState` (not `pushState`) to update the URL without creating history entries.
**Warning signs:** Broken back button navigation, unexpected page reloads.

### Pitfall 5: Detail Panel ID Clickability for Non-ULID Values
**What goes wrong:** ULID detection regex matches non-ID strings that happen to be 26 alphanumeric characters.
**Why it happens:** Overly broad ULID pattern matching.
**How to avoid:** ULIDs use Crockford's base32 (digits + uppercase letters excluding I, L, O, U). The regex `/^[0-9A-HJKMNP-TV-Z]{26}$/` is precise enough. Additionally, validate that clicked IDs exist in the loaded data before navigating. Show "ID not found in current data" for unresolvable IDs.
**Warning signs:** Random strings become clickable; clicking them leads to confusing "not found" states.

### Pitfall 6: Search Endpoint Overloading the Store
**What goes wrong:** Search endpoint reads all blackboard entries, all decisions, and all entities on every search request.
**Why it happens:** Each engine's search method loads all data from files, then filters.
**How to avoid:** For typical Twining projects (<1000 entries, <100 decisions, <200 entities), this is fast enough (<50ms). Don't prematurely optimize. The existing stores use synchronous `readFileSync` which is already fast for small files. If it becomes a problem in the future, add caching at the store level.
**Warning signs:** Search response times >500ms (very unlikely for typical datasets).

## Code Examples

### Unified Search Endpoint
```typescript
// In api-routes.ts — new /api/search handler

// Parse query params
const searchUrl = new URL(url, "http://localhost");
const q = searchUrl.searchParams.get("q") || "";
const types = (searchUrl.searchParams.get("types") || "blackboard,decisions,entities").split(",");
const scope = searchUrl.searchParams.get("scope") || undefined;
const status = searchUrl.searchParams.get("status") || undefined;
const tags = searchUrl.searchParams.get("tags") || undefined;
const since = searchUrl.searchParams.get("since") || undefined;
const until = searchUrl.searchParams.get("until") || undefined;
const limit = parseInt(searchUrl.searchParams.get("limit") || "20", 10);

// Collect results from each type
const results = [];

if (types.includes("blackboard") && q) {
  const bbResults = await blackboardEngine.query(q, {
    entry_types: undefined, // could filter by type
    limit: limit
  });
  for (const r of bbResults.results) {
    results.push({
      type: "blackboard",
      id: r.entry.id,
      summary: r.entry.summary,
      scope: r.entry.scope,
      timestamp: r.entry.timestamp,
      entry_type: r.entry.entry_type,
      relevance: r.relevance
    });
  }
}

if (types.includes("decisions") && q) {
  const decResults = await decisionEngine.searchDecisions(q, {
    status: status,
    // ... more filters
  }, limit);
  for (const r of decResults.results) {
    results.push({
      type: "decision",
      id: r.id,
      summary: r.summary,
      scope: r.scope,
      timestamp: r.timestamp,
      domain: r.domain,
      status: r.status,
      confidence: r.confidence,
      relevance: r.relevance
    });
  }
}

if (types.includes("entities") && q) {
  const graphResults = await graphEngine.query(q, undefined, limit);
  for (const ent of graphResults.entities) {
    results.push({
      type: "entity",
      id: ent.id,
      name: ent.name,
      entity_type: ent.type,
      properties: ent.properties,
      relevance: 0.5 // Fixed score for substring matches
    });
  }
}

// Sort by relevance descending, then by timestamp descending
results.sort((a, b) => {
  if (b.relevance !== a.relevance) return b.relevance - a.relevance;
  return (b.timestamp || "").localeCompare(a.timestamp || "");
});

sendJSON(res, {
  query: q,
  results: results.slice(0, limit),
  total: results.length,
  fallback_mode: bbResults?.fallback_mode ?? true
});
```

### Debounce Utility for Search Input
```javascript
// Source: standard debounce pattern
function debounce(fn, delay) {
  var timer = null;
  return function() {
    var args = arguments;
    var context = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function() {
      fn.apply(context, args);
      timer = null;
    }, delay);
  };
}

// Usage:
var debouncedSearch = debounce(performSearch, 300);
searchInput.addEventListener("input", debouncedSearch);
```

### Clickable ID Navigation
```javascript
// Navigate to an item by ID across all data types
function navigateToId(id) {
  // Check blackboard
  for (var i = 0; i < state.blackboard.data.length; i++) {
    if (state.blackboard.data[i].id === id) {
      switchTab("blackboard");
      state.blackboard.selectedId = id;
      renderBlackboard();
      renderBlackboardDetail(state.blackboard.data[i]);
      return;
    }
  }
  // Check decisions
  for (var j = 0; j < state.decisions.data.length; j++) {
    if (state.decisions.data[j].id === id) {
      switchTab("decisions");
      state.decisions.selectedId = id;
      renderDecisions();
      fetchDecisionDetail(id);
      return;
    }
  }
  // Check graph entities
  for (var k = 0; k < state.graph.data.length; k++) {
    if ((state.graph.data[k].id || state.graph.data[k].name) === id) {
      switchTab("graph");
      state.graph.selectedId = id;
      renderGraph();
      renderGraphDetail(state.graph.data[k]);
      return;
    }
  }
  // Not found in loaded data -- could try API lookup
  alert("ID not found in current data: " + id);
}
```

### Global Scope Filter
```javascript
// Apply global scope to any dataset
function applyGlobalScope(data, scopeField) {
  if (!state.globalScope) return data;
  var gs = state.globalScope;
  return data.filter(function(item) {
    var itemScope = item[scopeField || "scope"] || "";
    return itemScope.startsWith(gs) || gs.startsWith(itemScope);
  });
}

// In renderBlackboard:
function renderBlackboard() {
  var ts = state.blackboard;
  var filtered = applyGlobalScope(ts.data, "scope");
  var sorted = sortData(filtered, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);
  // ... render
}
```

### Search Results Rendering
```javascript
function renderSearchResults() {
  var ts = state.search;
  var container = document.querySelector("#search-results-body");
  if (!container) return;
  clearElement(container);

  for (var i = 0; i < ts.results.length; i++) {
    var result = ts.results[i];
    var tr = el("tr");

    // Type badge
    var tdType = el("td");
    tdType.appendChild(createBadge(result.type));
    tr.appendChild(tdType);

    // Summary/Name
    var tdSummary = el("td", null, result.summary || result.name || "--");
    tr.appendChild(tdSummary);

    // Scope
    var tdScope = el("td", null, result.scope || "--");
    tr.appendChild(tdScope);

    // Relevance (as percentage)
    var relPct = Math.round((result.relevance || 0) * 100);
    var tdRel = el("td", null, relPct + "%");
    tr.appendChild(tdRel);

    // Click to navigate
    (function(r) {
      tr.addEventListener("click", function() {
        navigateToId(r.id);
      });
    })(result);

    container.appendChild(tr);
  }

  // Fallback mode indicator
  if (ts.fallback_mode) {
    var notice = el("p", "search-fallback-notice", "Using keyword search (semantic search unavailable)");
    container.parentElement.appendChild(notice);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Server-side full-text search with dedicated search engine | Client-side filtering + server-side embedding search | 2024+ for small datasets | For <10k items, client-side filtering is fast enough for faceted search; semantic search requires server-side embeddings |
| Complex query DSL | Simple query params with AND logic | Ongoing | Users of dev tools prefer simple search over complex query languages |
| Instant search (search-as-you-type) | Debounced search (300ms) | Standard practice | Balances responsiveness with server load |
| Separate search page | Integrated search within dashboard | 2020+ | Single-page search feels more responsive for tool UIs |

**Deprecated/outdated:**
- Full-text search libraries (lunr.js, flexsearch) -- overkill for <1000 items; the existing keyword search in `search.ts` is sufficient
- jQuery autocomplete -- use native `<input>` + debounced fetch
- Server-side HTML rendering for search results -- use JSON API + client-side rendering (matches existing pattern)

## Open Questions

1. **Engine instance sharing between MCP server and dashboard**
   - What we know: The `Embedder.getInstance()` singleton means both the MCP server and dashboard share the same ONNX model instance even if they create separate Embedder references. Stores are cheap file-path wrappers.
   - What's unclear: Whether creating parallel engine instances in the API handler introduces subtle issues (e.g., concurrent file reads during MCP writes).
   - Recommendation: Use the existing singleton Embedder pattern and create independent store/engine instances in the API handler (Option B from Pattern 2). File reads don't require locks and won't conflict with MCP writes. This is consistent with the Phase 8 pattern.

2. **Graph entity relevance scoring**
   - What we know: `GraphEngine.query()` returns substring matches without a relevance score. Blackboard and decision search return float relevance scores.
   - What's unclear: How to meaningfully rank graph entities alongside scored results.
   - Recommendation: Assign a fixed relevance score (0.5) for graph substring matches. This places them below high-relevance semantic matches but above low-relevance keyword matches. If graph entities have embeddings in a future phase, upgrade to proper relevance scoring then.

3. **Date range filtering granularity**
   - What we know: `BlackboardStore.read()` already supports `since` (ISO 8601 timestamp). There's no built-in `until` filter.
   - What's unclear: Whether `until` is needed or if `since` is sufficient.
   - Recommendation: Add both `since` and `until` to the search endpoint. Apply `until` as a simple `entry.timestamp <= until` filter in the API handler. For the frontend, use `<input type="date">` elements. The date range is most useful for blackboard entries (which accumulate over time); decisions and entities are typically few enough to not need date filtering.

4. **How to handle search while data is still loading**
   - What we know: On initial page load, data arrays are empty until the first poll completes. If user searches before data loads, client-side ID lookup for navigation will fail.
   - What's unclear: Whether to block search until initial data load or handle gracefully.
   - Recommendation: The `/api/search` endpoint works server-side and doesn't depend on client-side data. Navigation after clicking a result should fetch the specific tab's data if not already loaded. Show a brief "Loading..." state while data is fetched for the target tab.

5. **Should the search tab replace or complement existing tab browsing?**
   - What we know: Phase 8 has 4 tabs (Stats, Blackboard, Decisions, Graph). Search results span all types.
   - What's unclear: UX flow for going from search results back to tab browsing.
   - Recommendation: Add "Search" as a fifth tab. Searching auto-switches to it. Users can manually switch to other tabs to browse. The global scope filter applies to all tabs including search. This keeps the navigation model simple and consistent.

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/embeddings/search.ts` -- verified SearchEngine with cosine similarity and keyword fallback, BlackboardSearchResult and DecisionSearchResult interfaces
- Existing codebase: `src/embeddings/embedder.ts` -- verified lazy-loaded ONNX pipeline with singleton pattern (`Embedder.getInstance()`), fallback mode detection
- Existing codebase: `src/engine/blackboard.ts` -- verified `query()` method delegating to SearchEngine
- Existing codebase: `src/engine/decisions.ts` -- verified `searchDecisions()` with domain/status/confidence filters, keyword fallback
- Existing codebase: `src/engine/graph.ts` -- verified `query()` method with substring matching on entity names and properties
- Existing codebase: `src/dashboard/api-routes.ts` -- verified Phase 8 API handler pattern with store instances in closure
- Existing codebase: `src/dashboard/public/app.js` -- verified Phase 8 frontend patterns (tab navigation, sorting, pagination, detail inspector, polling)
- Existing codebase: `src/utils/types.ts` -- verified data model interfaces (BlackboardEntry, Decision, Entity fields relevant to search/filter)

### Secondary (MEDIUM confidence)
- `.planning/phases/08-observability-dashboard/08-RESEARCH.md` -- Phase 8 architecture patterns that Phase 9 extends
- `.planning/phases/08-observability-dashboard/08-VERIFICATION.md` -- confirmed Phase 8 completion, all 12 truths verified
- `.planning/ROADMAP.md` -- Phase 9 requirements and success criteria

### Tertiary (LOW confidence)
- General debounce patterns for search UIs -- well-established, no specific source needed
- ULID format specification (Crockford's base32, 26 chars) -- verified against the `ulid` npm package documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- No new dependencies; all existing internal modules provide needed search/filter capabilities
- Architecture: HIGH -- Direct extension of Phase 8 patterns; search engines already implemented and tested; API endpoint pattern is well-established
- Pitfalls: HIGH -- Primary pitfalls (cold-start latency, score normalization, scope+search interaction) identified from direct codebase analysis; UI pitfalls (debounce, XSS, ID detection) are well-understood web development patterns
- Frontend patterns: HIGH -- Vanilla JS search UI, filter controls, and navigation are straightforward DOM API usage; no novel techniques required

**Research date:** 2026-02-17
**Valid until:** 2026-04-17 (stable domain; internal APIs are under our control; no external dependency changes expected)
