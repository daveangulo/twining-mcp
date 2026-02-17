# Phase 14: Agent Dashboard - Research

**Researched:** 2026-02-17
**Domain:** Extending existing vanilla JS dashboard with agent coordination views
**Confidence:** HIGH

## Summary

Phase 14 adds three agent coordination views to the existing Twining web dashboard: an Agents tab showing registered agents with status/capabilities/liveness, a Delegations view showing pending delegation needs with matching agent suggestions, and a Handoffs view showing handoff history with acknowledgment status. This builds directly on the v1.2 dashboard architecture (Phase 7-10) and the v1.3 agent coordination data layer (Phase 11-13).

The implementation requires two layers: (1) three new API endpoints (`/api/agents`, `/api/delegations`, `/api/handoffs`) in `api-routes.ts` that read from `AgentStore`, `BlackboardStore`, and `HandoffStore`, and (2) frontend additions in `app.js`, `index.html`, and `style.css` that render the new tabs using the same patterns established in Phase 8 (sortable tables, detail panels, polling, scope filtering). The delegation view also needs agent scoring logic (using `scoreAgent` from `coordination.ts`) to show which agents match each delegation need.

No new npm dependencies are needed. The existing stores (`AgentStore`, `HandoffStore`, `BlackboardStore`) already have all the read methods required. The `scoreAgent` pure function from `coordination.ts` can be imported directly into `api-routes.ts` for agent-delegation matching. The frontend follows the exact same vanilla JS patterns used for the existing 5 tabs.

**Primary recommendation:** Add 3 API endpoints and 3 frontend tabs following the exact same architectural patterns used in Phase 8-10. Import `AgentStore`, `HandoffStore`, and `scoreAgent` into `api-routes.ts`. Add "Agents", "Delegations", and "Handoffs" tabs to the frontend with the same table/detail/pagination/polling patterns. Include liveness badge styling and delegation expiry indicators.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DASH-01 | Dashboard includes Agents tab showing registered agents with status and capabilities | `/api/agents` endpoint reads from `AgentStore.getAll()`, computes liveness via `computeLiveness()`, returns agent records with liveness. Frontend renders sortable table with liveness badges (active/idle/gone), capabilities as tag badges, role, description, registration time, last active time. |
| DASH-02 | Dashboard shows pending delegation needs with matching agent suggestions | `/api/delegations` endpoint reads blackboard entries with `entry_type: "need"`, parses delegation metadata from `detail` field via `parseDelegationMetadata()`, filters to non-expired entries, scores registered agents against required capabilities using `scoreAgent()`. Frontend renders delegations with urgency badges, expiry countdown, required capabilities, and ranked suggested agents. |
| DASH-03 | Dashboard shows handoff history with status | `/api/handoffs` endpoint reads from `HandoffStore.list()`, returns handoff index entries with id, created_at, source_agent, target_agent, scope, summary, result_status, acknowledged. Frontend renders sortable table with status badges (completed/partial/blocked/failed/mixed), acknowledgment indicator, source/target agent display, and detail panel showing full handoff with context snapshot. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:http` | (built-in) | API endpoint handling | Already used by existing dashboard; extend `createApiHandler` with new routes |
| Vanilla JavaScript | ES2020+ | Client-side rendering | Project constraint: no build step, no frameworks. All existing tabs use this pattern |
| CSS Grid/Flexbox | (built-in) | Layout for new tabs | Matches existing dashboard layout patterns |
| `AgentStore` | (internal) | Read agent registry | Instantiate from `twiningDir` path, same as existing stores in `api-routes.ts` |
| `HandoffStore` | (internal) | Read handoff history | Instantiate from `twiningDir` path |
| `BlackboardStore` | (internal) | Read delegation entries (blackboard "need" entries with delegation metadata) | Already instantiated in `api-routes.ts` |
| `scoreAgent` | (internal) | Score agents against delegation requirements | Pure function import from `coordination.ts` |
| `parseDelegationMetadata` | (internal) | Parse delegation metadata from blackboard entry detail | Pure function import from `coordination.ts` |
| `isDelegationExpired` | (internal) | Check if delegation has expired | Pure function import from `coordination.ts` |
| `computeLiveness` | (internal) | Compute agent liveness from timestamp | Pure function import from `liveness.ts` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `DEFAULT_LIVENESS_THRESHOLDS` | (internal) | Default liveness thresholds | Used when config doesn't specify custom thresholds |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Three separate tabs (Agents, Delegations, Handoffs) | Single "Coordination" tab with sub-views | Three tabs matches the existing pattern (Stats, Blackboard, Decisions, Graph, Search) and keeps each view focused. A single tab with sub-views would need nested navigation UI. |
| Client-side agent scoring for delegations | Pre-compute scores server-side | Server-side is better because scoring requires all agent records. The API returns pre-scored results. |
| Separate `/api/delegations` endpoint | Filter delegations client-side from `/api/blackboard` | Dedicated endpoint is cleaner: parses delegation metadata, filters expired, scores agents -- client would need to duplicate complex logic. |

**Installation:**
```bash
# No new dependencies needed -- everything is built-in or already in the project
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── dashboard/
│   ├── http-server.ts       # UNCHANGED
│   ├── api-routes.ts        # MODIFIED: add /api/agents, /api/delegations, /api/handoffs
│   ├── dashboard-config.ts  # UNCHANGED
│   └── public/
│       ├── index.html       # MODIFIED: add 3 new tab buttons and tab content sections
│       ├── style.css        # MODIFIED: add liveness badges, delegation/handoff styles
│       └── app.js           # MODIFIED: add fetch/render/state for 3 new tabs
test/
├── dashboard/
│   ├── api-routes.test.ts   # MODIFIED: add tests for new API endpoints
│   └── (http-server tests unchanged)
```

### Pattern 1: API Route Handler (following existing convention)
**What:** Add new API routes to `createApiHandler()` in `api-routes.ts`. Each route reads from stores instantiated in the closure, returns JSON via `sendJSON()`. Uninitialized projects return empty arrays with `initialized: false`.
**When to use:** All 3 new API endpoints.
**Example:**
```typescript
// Inside createApiHandler() closure, add AgentStore and HandoffStore
const agentStore = new AgentStore(twiningDir);
const handoffStore = new HandoffStore(twiningDir);

// GET /api/agents
if (url === "/api/agents") {
  if (!fs.existsSync(twiningDir)) {
    sendJSON(res, { initialized: false, agents: [], total: 0 });
    return true;
  }
  const agents = await agentStore.getAll();
  const now = new Date();
  const mapped = agents.map(agent => ({
    ...agent,
    liveness: computeLiveness(agent.last_active, now, DEFAULT_LIVENESS_THRESHOLDS),
  }));
  sendJSON(res, { initialized: true, agents: mapped, total: mapped.length });
  return true;
}
```

### Pattern 2: Delegation Endpoint with Agent Scoring
**What:** Read blackboard "need" entries, parse delegation metadata, filter expired, score agents against each delegation's required capabilities.
**When to use:** `/api/delegations` endpoint.
**Example:**
```typescript
// GET /api/delegations
if (url === "/api/delegations") {
  if (!fs.existsSync(twiningDir)) {
    sendJSON(res, { initialized: false, delegations: [], total: 0 });
    return true;
  }
  const { entries } = await blackboardStore.read({ entry_types: ["need"] });
  const agents = await agentStore.getAll();
  const now = new Date();

  const delegations = [];
  for (const entry of entries) {
    const meta = parseDelegationMetadata(entry);
    if (!meta) continue; // Not a delegation entry
    const expired = isDelegationExpired(meta, now);
    const scores = agents.map(a =>
      scoreAgent(a, meta.required_capabilities, DEFAULT_LIVENESS_THRESHOLDS, now)
    ).filter(s => s.liveness !== "gone")
     .sort((a, b) => b.total_score - a.total_score);

    delegations.push({
      entry_id: entry.id,
      timestamp: entry.timestamp,
      summary: entry.summary,
      scope: entry.scope,
      agent_id: entry.agent_id,
      required_capabilities: meta.required_capabilities,
      urgency: meta.urgency,
      expires_at: meta.expires_at,
      expired,
      suggested_agents: scores.slice(0, 5),
    });
  }
  sendJSON(res, { initialized: true, delegations, total: delegations.length });
  return true;
}
```

### Pattern 3: Frontend Tab (following existing convention)
**What:** Add state, fetch function, render function, and detail renderer following the exact patterns of existing tabs.
**When to use:** All 3 new tabs.
**Example:**
```javascript
// State additions
var state = {
  // ...existing...
  agents: { data: [], sortKey: "agent_id", sortDir: "asc", page: 1, pageSize: 25, selectedId: null },
  delegations: { data: [], sortKey: "timestamp", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
  handoffs: { data: [], sortKey: "created_at", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
};

// Fetch function (same pattern as fetchBlackboard)
function fetchAgents() {
  fetch("/api/agents")
    .then(function(res) { return res.json(); })
    .then(function(data) {
      state.agents.data = data.agents || [];
      state.connected = true;
      updateConnectionIndicator();
      renderAgents();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}
```

### Pattern 4: Liveness Badge Styling
**What:** Color-coded badges for agent liveness status: green for active, amber for idle, red for gone.
**When to use:** Agents tab, delegation suggested agents.
**Example:**
```css
.badge.liveness-active { background: #dcfce7; color: #166534; }
.badge.liveness-idle { background: #fef3c7; color: #92400e; }
.badge.liveness-gone { background: #fecaca; color: #991b1b; }

/* Dark mode variants */
[data-theme="dark"] .badge.liveness-active { background: #064e3b; color: #a7f3d0; }
[data-theme="dark"] .badge.liveness-idle { background: #451a03; color: #fde68a; }
[data-theme="dark"] .badge.liveness-gone { background: #450a0a; color: #fecaca; }
```

### Anti-Patterns to Avoid
- **Duplicating scoring logic in frontend:** Agent scoring for delegations MUST be computed server-side in the API endpoint. The frontend should never re-implement `scoreAgent`.
- **Creating engine instances in api-routes:** Only stores and pure functions should be imported. Do NOT instantiate `CoordinationEngine` (it has heavy constructor dependencies). Import `scoreAgent`, `parseDelegationMetadata`, `isDelegationExpired`, and `computeLiveness` as pure functions.
- **Adding new vendor libraries:** No new JS libraries needed. The existing table/detail/pagination infrastructure handles everything.
- **Breaking the stdout constraint:** CRITICAL: Never use `console.log` or `process.stdout` in dashboard server code. Only `console.error` is safe. MCP StdioServerTransport owns stdout.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Agent scoring | Custom scoring in api-routes | Import `scoreAgent` from `coordination.ts` | Already tested, handles edge cases (zero capabilities, normalization) |
| Delegation metadata parsing | Custom JSON parsing | Import `parseDelegationMetadata` from `coordination.ts` | Validates `type: "delegation"`, handles malformed JSON |
| Delegation expiry check | Custom date comparison | Import `isDelegationExpired` from `coordination.ts` | Boundary-inclusive comparison, tested |
| Liveness computation | Custom elapsed time logic | Import `computeLiveness` from `liveness.ts` | Handles thresholds correctly, tested |
| Table sorting/pagination | New sorting infrastructure | Use existing `sortData()`, `paginate()`, `renderPagination()` from app.js | Already handles all edge cases, used by 5 existing tabs |
| Badge rendering | New badge helpers | Use existing `createBadge()` from app.js | Already handles light/dark mode, consistent styling |
| Detail panel rendering | New detail infrastructure | Follow existing `renderBlackboardDetail()` pattern | Consistent UX, handles clickable IDs, text truncation |

**Key insight:** Every piece of backend logic needed is already a tested pure function. Every piece of frontend rendering infrastructure already exists. This phase is almost entirely composition and integration.

## Common Pitfalls

### Pitfall 1: Forgetting Uninitialized Project Guard
**What goes wrong:** API endpoint crashes when `.twining/` directory doesn't exist.
**Why it happens:** New endpoints skip the `fs.existsSync(twiningDir)` guard that all existing endpoints have.
**How to avoid:** Every new API endpoint MUST check `fs.existsSync(twiningDir)` and return `{ initialized: false, ..., total: 0 }` if missing. Copy the exact pattern from existing endpoints.
**Warning signs:** Dashboard shows errors or blank data when Twining hasn't been used yet.

### Pitfall 2: Import Path for Pure Functions from Engine Layer
**What goes wrong:** Importing from `coordination.ts` pulls in the entire `CoordinationEngine` class with heavy dependencies.
**Why it happens:** `scoreAgent`, `parseDelegationMetadata`, and `isDelegationExpired` are exported from the same file as `CoordinationEngine`.
**How to avoid:** Import only the specific named exports needed. TypeScript tree-shaking handles this correctly for named exports. The functions have no side effects or shared state.
**Warning signs:** Import errors or circular dependency issues.

### Pitfall 3: Delegation Entries Mixed with Regular Needs
**What goes wrong:** Not all blackboard entries with `entry_type: "need"` are delegations. Some are regular needs posted by agents.
**Why it happens:** Delegations are stored as blackboard "need" entries with delegation metadata in the `detail` field.
**How to avoid:** Use `parseDelegationMetadata()` to distinguish. It returns `null` for non-delegation entries. Filter: `entries.filter(e => parseDelegationMetadata(e) !== null)`.
**Warning signs:** Regular "need" entries appear in the delegations tab.

### Pitfall 4: Agent Store Not Instantiated in api-routes.ts
**What goes wrong:** `/api/agents` and `/api/delegations` can't access agent data.
**Why it happens:** The existing `createApiHandler` only instantiates `BlackboardStore`, `DecisionStore`, and `GraphStore`.
**How to avoid:** Add `AgentStore` and `HandoffStore` instantiation in the `createApiHandler` closure, alongside existing stores. Follow the same pattern: `const agentStore = new AgentStore(twiningDir);`
**Warning signs:** 404 or empty responses from agent-related endpoints.

### Pitfall 5: Handoff Detail Endpoint Missing
**What goes wrong:** Clicking a handoff in the list shows no detail.
**Why it happens:** The list endpoint uses `HandoffStore.list()` which returns lightweight index entries. Full handoff data (context_snapshot, results array) requires `HandoffStore.get(id)`.
**How to avoid:** Add a `/api/handoffs/:id` endpoint (same pattern as `/api/decisions/:id`) that calls `handoffStore.get(id)` for full record.
**Warning signs:** Detail panel missing context snapshot and results when clicking a handoff.

### Pitfall 6: Tab Count Increases UI Crowding
**What goes wrong:** 8 tabs (Stats, Blackboard, Decisions, Graph, Search + Agents, Delegations, Handoffs) may overflow on narrow screens.
**Why it happens:** Each new tab adds a button to the fixed-width tab bar.
**How to avoid:** Keep tab names short ("Agents", "Delegations", "Handoffs"). Consider whether Delegations and Handoffs should be sub-views under an "Agents" tab with view toggles (like Decisions has Table/Timeline, Graph has Table/Visual). This keeps the top-level tab count at 6 instead of 8.
**Warning signs:** Tab bar wraps or clips on screens < 1200px wide.

### Pitfall 7: Polling All Three New Endpoints
**What goes wrong:** Adding 3 more polling endpoints triples the HTTP request rate.
**Why it happens:** Current `refreshData()` polls status + active tab data every 3 seconds.
**How to avoid:** Only poll the active tab's endpoint, same as the existing pattern. The `refreshData()` function already switches on `state.activeTab` -- just add the new tab cases.
**Warning signs:** Excessive HTTP requests visible in browser DevTools.

## Code Examples

Verified patterns from the existing codebase:

### Existing Tab Pattern (app.js state initialization)
```javascript
// Source: src/dashboard/public/app.js lines 11-17
var state = {
  activeTab: "stats",
  blackboard: { data: [], sortKey: "timestamp", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
  decisions: { data: [], sortKey: "timestamp", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
  // ... add same pattern for agents, delegations, handoffs
};
```

### Existing Fetch Pattern (app.js)
```javascript
// Source: src/dashboard/public/app.js lines 122-138
function fetchBlackboard() {
  fetch("/api/blackboard")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.blackboard.data = data.entries || [];
      state.connected = true;
      updateConnectionIndicator();
      renderBlackboard();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}
```

### Existing API Endpoint Pattern (api-routes.ts)
```typescript
// Source: src/dashboard/api-routes.ts lines 258-330
// GET /api/status
if (url === "/api/status") {
  try {
    if (!fs.existsSync(twiningDir)) {
      sendJSON(res, { initialized: false, /* ...zeros... */ });
      return true;
    }
    // ...read from stores...
    sendJSON(res, { initialized: true, /* ...data... */ });
  } catch (err: unknown) {
    console.error("[twining] API /api/status error:", err);
    sendJSON(res, { error: "Internal server error" }, 500);
  }
  return true;
}
```

### Existing Test Pattern (api-routes.test.ts)
```typescript
// Source: test/dashboard/api-routes.test.ts
// Tests create a temp project with .twining/ data, start an HTTP server on port 0,
// make HTTP GET requests via helper, assert JSON response structure and values.
// Both initialized and uninitialized project scenarios are tested.
```

### Agent Data Available from AgentStore
```typescript
// Source: src/utils/types.ts lines 250-257
interface AgentRecord {
  agent_id: string;
  capabilities: string[];
  role?: string;
  description?: string;
  registered_at: string;
  last_active: string;
}
```

### Handoff Index Data Available from HandoffStore
```typescript
// Source: src/utils/types.ts lines 287-301
interface HandoffIndexEntry {
  id: string;
  created_at: string;
  source_agent: string;
  target_agent?: string;
  scope?: string;
  summary: string;
  result_status: "completed" | "partial" | "blocked" | "failed" | "mixed";
  acknowledged: boolean;
}
```

### Full Handoff Data Available from HandoffStore.get(id)
```typescript
// Source: src/utils/types.ts lines 268-284
interface HandoffRecord {
  id: string;
  created_at: string;
  source_agent: string;
  target_agent?: string;
  scope?: string;
  summary: string;
  results: HandoffResult[];
  context_snapshot: {
    decision_ids: string[];
    warning_ids: string[];
    finding_ids: string[];
    summaries: string[];
  };
  acknowledged_by?: string;
  acknowledged_at?: string;
}
```

### Delegation Metadata from Blackboard Entries
```typescript
// Source: src/utils/types.ts lines 337-343
interface DelegationMetadata {
  type: "delegation";
  required_capabilities: string[];
  urgency: DelegationUrgency; // "high" | "normal" | "low"
  expires_at: string;
  timeout_ms?: number;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| N/A (no dashboard agent views) | Add API endpoints + frontend tabs | Phase 14 | Makes agent coordination visible to humans |

**No deprecated/outdated concerns:** This phase uses the same vanilla JS + Node.js HTTP patterns established in Phase 7-10. No technology changes needed.

## Open Questions

1. **Tab organization: 8 tabs vs 6 tabs with sub-views?**
   - What we know: Current dashboard has 5 tabs. Adding 3 more makes 8. The Decisions tab already has Table/Timeline sub-views. The Graph tab has Table/Visual sub-views.
   - What's unclear: Whether 8 tabs crowd the UI, especially on narrow screens.
   - Recommendation: Use a single "Agents" tab with Agents/Delegations/Handoffs as sub-views (using the existing view-toggle button pattern from Decisions and Graph tabs). This keeps the top-level tab count at 6. The three views are conceptually related (all about agent coordination). **MEDIUM confidence** -- this is a UX judgment call the planner should make.

2. **Should `/api/status` include agent/delegation/handoff counts?**
   - What we know: `twining_status` already includes `registered_agents` and `active_agents` counts (added in Phase 13). The dashboard `/api/status` endpoint does NOT yet include these.
   - What's unclear: Whether to also add pending_delegations and total_handoffs counts.
   - Recommendation: YES -- add `registered_agents`, `active_agents`, `pending_delegations`, and `total_handoffs` to the `/api/status` response. Display them in the Stats tab alongside existing counts. This gives at-a-glance coordination visibility. **HIGH confidence**.

3. **Delegation freshness: show expired delegations or not?**
   - What we know: `isDelegationExpired()` checks if `now >= expires_at`. Expired delegations are still blackboard entries.
   - What's unclear: Whether to show expired delegations (grayed out) or hide them entirely.
   - Recommendation: Show all delegations by default, with expired ones visually distinguished (opacity/strikethrough, similar to superseded decisions). Add a "Hide expired" toggle. **MEDIUM confidence**.

## Sources

### Primary (HIGH confidence)
- **Existing codebase** - `src/dashboard/api-routes.ts`, `src/dashboard/public/app.js`, `src/dashboard/public/index.html`, `src/dashboard/public/style.css` -- all existing dashboard patterns
- **Existing stores** - `src/storage/agent-store.ts`, `src/storage/handoff-store.ts`, `src/storage/blackboard-store.ts` -- all data access methods
- **Existing coordination logic** - `src/engine/coordination.ts` -- `scoreAgent`, `parseDelegationMetadata`, `isDelegationExpired` pure functions
- **Existing liveness utility** - `src/utils/liveness.ts` -- `computeLiveness`, `DEFAULT_LIVENESS_THRESHOLDS`
- **Type definitions** - `src/utils/types.ts` -- `AgentRecord`, `HandoffRecord`, `HandoffIndexEntry`, `DelegationMetadata`, `AgentScore`
- **Existing tests** - `test/dashboard/api-routes.test.ts` -- testing patterns for HTTP API endpoints
- **Requirements** - `.planning/REQUIREMENTS.md` -- DASH-01, DASH-02, DASH-03 definitions

### Secondary (MEDIUM confidence)
- **Phase 8 research** - `.planning/milestones/v1.2-phases/08-observability-dashboard/08-RESEARCH.md` -- original dashboard architecture decisions

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies; all code references verified in existing codebase
- Architecture: HIGH - Following exact same patterns as existing dashboard (5 tabs, same API/frontend split)
- Pitfalls: HIGH - Identified from actual codebase analysis (uninitialized guards, delegation parsing, store instantiation)

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (stable -- no external dependencies to change)
