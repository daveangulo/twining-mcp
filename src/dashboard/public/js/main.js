/**
 * Orchestrator for the scale-native dashboard views (ES modules).
 *
 * Owns the shared client index store and mounts the new views tab-by-tab as
 * they replace legacy app.js renderers. app.js keeps owning tab switching,
 * status polling for the header, and the not-yet-migrated tabs; this module
 * listens to the same tab buttons via event delegation and never modifies
 * app.js state except the documented window bridges.
 */
import { createIndexStore } from "./store.js";
import { createListView, COLUMNS } from "./list-view.js";
import { createDensityTimeline } from "./density-timeline.js";
import { createGraphView } from "./graph-view.js";
import { renderHealthCards } from "./health.js";
import { createScopeNav } from "./scope-nav.js";
import { createTriageView, deepLinkTab } from "./triage-view.js";
import { linkifyInto, setRepoInfo } from "./linkify.js";

// Best-effort remote link derivation (spec §8): fetched once; links stay
// local-only if this fails or there is no remote.
fetch("/api/repo-info")
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => setRepoInfo(info))
  .catch(() => {});
import { readRoute, writeRoute, onRouteChange, syncCurrent } from "./router.js";

// True while applyRoute() is driving the views — suppresses writeRoute echoes.
let applyingRoute = false;
function route(partial, opts) {
  if (applyingRoute) return;
  if (partial.filter) {
    // kinds (fixed per view) and scope (own hash param) are internal keys.
    const { kinds: _k, scope: _s, ...rest } = partial.filter;
    partial = { ...partial, filter: Object.keys(rest).length ? rest : undefined };
  }
  writeRoute(partial, opts);
}
import { el, clearElement, formatTimestamp } from "./util.js";

const POLL_MS = 5000;

const store = createIndexStore({});
// Transitional bridge: exposed for debugging and for later-phase modules.
window.__twiningStore = store;

/* ------------------------------------------------------------------ */
/* Detail renderers (fetch full body on select)                        */
/* ------------------------------------------------------------------ */

function detailField(panel, label, value, asPre) {
  if (value === undefined || value === null || value === "") return;
  const div = el("div", "detail-field");
  div.appendChild(el("div", "detail-label", label));
  const val = el("div", "detail-value");
  if (label === "ID" && typeof window.renderIdValue === "function") {
    window.renderIdValue(val, String(value));
  } else if (asPre) {
    const pre = el("pre", null);
    linkifyInto(pre, String(value));
    val.appendChild(pre);
  } else {
    linkifyInto(val, String(value));
  }
  div.appendChild(val);
  panel.appendChild(div);
}

async function showBlackboardDetail(row) {
  const panel = document.getElementById("blackboard-detail");
  if (!panel) return;
  clearElement(panel);
  panel.appendChild(el("p", "placeholder", "Loading…"));
  try {
    const res = await fetch(`/api/blackboard/${encodeURIComponent(row.id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entry = await res.json();
    clearElement(panel);
    panel.appendChild(el("h3", null, "Entry Details"));
    detailField(panel, "ID", entry.id);
    detailField(panel, "Timestamp", formatTimestamp(entry.timestamp));
    detailField(panel, "Type", entry.entry_type);
    detailField(panel, "Summary", entry.summary);
    detailField(panel, "Scope", entry.scope);
    detailField(panel, "Agent ID", entry.agent_id);
    detailField(panel, "Tags", entry.tags && entry.tags.length ? entry.tags.join(", ") : null);
    detailField(panel, "Origin", entry.origin || null);
    if (entry.relates_to && entry.relates_to.length) {
      const div = el("div", "detail-field");
      div.appendChild(el("div", "detail-label", "Relates To"));
      const val = el("div", "detail-value");
      if (typeof window.renderIdList === "function") window.renderIdList(val, entry.relates_to);
      else val.textContent = entry.relates_to.join(", ");
      div.appendChild(val);
      panel.appendChild(div);
    }
    detailField(panel, "Detail", entry.detail, true);
  } catch (err) {
    clearElement(panel);
    panel.appendChild(el("p", "placeholder", "Could not load entry — it may have been archived."));
  }
}

/* ------------------------------------------------------------------ */
/* Blackboard tab                                                      */
/* ------------------------------------------------------------------ */

let blackboardList = null;

function mountBlackboard() {
  const host = document.getElementById("blackboard-listview");
  if (!host || blackboardList) return;
  blackboardList = createListView(host, {
    store,
    kinds: ["blackboard"],
    columns: [COLUMNS.time, COLUMNS.type, COLUMNS.scope, COLUMNS.summary],
    facets: [
      { filterKey: "entryTypes", field: "entry_type", label: "Type" },
      { filterKey: "tags", field: "tags", label: "Tags" },
    ],
    onSelect: (row) => {
      route({ sel: row.id }, { push: true });
      showBlackboardDetail(row);
    },
    onFilterChange: (f) => {
      if (activeTab() === "blackboard") route({ filter: f });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Decisions tab                                                       */
/* ------------------------------------------------------------------ */

let decisionsList = null;

async function showDecisionDetail(row, panelId = "decisions-detail") {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  clearElement(panel);
  panel.appendChild(el("p", "placeholder", "Loading…"));
  try {
    const res = await fetch(`/api/decisions/${encodeURIComponent(row.id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const decision = await res.json();
    // Rich renderer (alternatives, supersession chain links) still lives in
    // app.js; reachable because app.js is a classic script.
    if (typeof window.renderDecisionDetail === "function") {
      window.renderDecisionDetail(decision, panelId);
    } else {
      clearElement(panel);
      panel.appendChild(el("pre", null, JSON.stringify(decision, null, 2)));
    }
  } catch {
    clearElement(panel);
    panel.appendChild(el("p", "placeholder", "Could not load decision."));
  }
}

function mountDecisions() {
  const host = document.getElementById("decisions-listview");
  if (!host || decisionsList) return;
  decisionsList = createListView(host, {
    store,
    kinds: ["decision"],
    columns: [COLUMNS.time, COLUMNS.status, COLUMNS.domain, COLUMNS.scope, COLUMNS.confidence, COLUMNS.summary],
    facets: [
      { filterKey: "statuses", field: "status", label: "Status" },
      { filterKey: "domains", field: "domain", label: "Domain" },
      { filterKey: "confidences", field: "confidence", label: "Conf" },
    ],
    onSelect: (row) => {
      route({ sel: row.id }, { push: true });
      showDecisionDetail(row);
    },
    onFilterChange: (f) => {
      if (activeTab() === "decisions") route({ filter: f });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Triage tab                                                          */
/* ------------------------------------------------------------------ */

let triageView = null;

function mountTriage() {
  const host = document.getElementById("triage-view");
  if (!host || triageView) return;
  triageView = createTriageView(host, {
    store,
    // Deep links reuse the sel= hash mechanism (§8): id + kind are
    // sufficient — the tab comes from item.kind via deepLinkTab, never from
    // a client-index lookup, so a triage click routes correctly even before
    // the first /api/index poll lands. The detail renderers fetch by id.
    onSelect: (item) => {
      const tab = deepLinkTab(item.kind);
      route({ tab, sel: item.id, anchor: undefined, view: undefined }, { push: true });
      if (typeof window.switchTab === "function") window.switchTab(tab);
      requestAnimationFrame(() => {
        if (tab === "blackboard") showBlackboardDetail(item);
        else showDecisionDetail(item);
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Decisions timeline (canvas density timeline + synced list)          */
/* ------------------------------------------------------------------ */

let timeline = null;
let timelineSyncedList = null;

function mountTimeline() {
  const host = document.getElementById("timeline-container");
  const listHost = document.getElementById("timeline-synced-list");
  if (!host || timeline) return;
  timeline = createDensityTimeline(host, {
    store,
    onSelect: (row) => showDecisionDetail(row, "decisions-timeline-detail"),
    onRangeChange: (brush, filterPatch) => {
      route({ range: brush || undefined });
      if (!timelineSyncedList) return;
      const f = filterPatch || timeline.getFilter();
      timelineSyncedList.setFilter({
        ...f,
        from: brush ? new Date(brush.fromMs).toISOString() : undefined,
        to: brush ? new Date(brush.toMs).toISOString() : undefined,
      });
    },
  });
  if (listHost) {
    timelineSyncedList = createListView(listHost, {
      store,
      kinds: ["decision"],
      columns: [COLUMNS.time, COLUMNS.status, COLUMNS.domain, COLUMNS.summary],
      facets: [],
      onSelect: (row) => showDecisionDetail(row, "decisions-timeline-detail"),
    });
  }
}

// Legacy toggleView (app.js) calls this bridge when the timeline view is shown.
window.__twiningTimelineShown = () => {
  route({ view: "timeline" });
  mountTimeline();
  if (timeline) {
    timeline.refresh();
    requestAnimationFrame(() => timeline.fit());
  }
  if (timelineSyncedList) timelineSyncedList.refresh();
};

/* ------------------------------------------------------------------ */
/* Graph tab: drill-down explorer (visual) + paged entity table        */
/* ------------------------------------------------------------------ */

let graphView = null;

// Legacy toggleView (app.js) calls this bridge when the Visual view is shown.
window.__twiningGraphShown = () => {
  route({ view: "visual" });
  const host = document.getElementById("graph-canvas");
  if (!host) return;
  if (!graphView) graphView = createGraphView(host, { onEntitySelect: (id) => route({ anchor: id }, { push: true }) });
  else graphView.refresh();
};

function exploreInGraph(entityId) {
  if (typeof window.toggleView === "function") window.toggleView("graph", "visual");
  requestAnimationFrame(() => {
    if (!graphView) window.__twiningGraphShown();
    if (graphView) graphView.focus(entityId);
  });
}

const graphTablePage = { offset: 0, limit: 50, total: 0 };

async function renderGraphTablePage() {
  const tbody = document.querySelector("#graph-table tbody");
  if (!tbody) return;
  let body;
  try {
    const res = await fetch(`/api/graph/entities?offset=${graphTablePage.offset}&limit=${graphTablePage.limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch {
    return;
  }
  graphTablePage.total = body.total;
  clearElement(tbody);
  for (const ent of body.entities) {
    const tr = el("tr");
    for (const text of [ent.name, ent.type, String(ent.degree)]) tr.appendChild(el("td", null, text));
    tr.addEventListener("click", () => {
      const panel = document.getElementById("graph-detail");
      if (!panel) return;
      clearElement(panel);
      panel.appendChild(el("h3", null, "Entity"));
      for (const [label, value] of [["Name", ent.name], ["Type", ent.type], ["Degree", ent.degree], ["ID", ent.id]]) {
        const div = el("div", "detail-field");
        div.appendChild(el("div", "detail-label", label));
        div.appendChild(el("div", "detail-value", String(value)));
        panel.appendChild(div);
      }
      const btn = el("button", "lv-chip", "Explore in graph →");
      btn.type = "button";
      btn.addEventListener("click", () => exploreInGraph(ent.id));
      panel.appendChild(btn);
    });
    tbody.appendChild(tr);
  }
  const info = document.getElementById("graph-relations-info");
  if (info) info.textContent = `${graphTablePage.offset + 1}–${graphTablePage.offset + body.entities.length} of ${body.total} entities (by degree)`;
  const pager = document.getElementById("graph-pagination");
  if (pager) {
    clearElement(pager);
    const prev = el("button", "lv-chip", "← Prev");
    const next = el("button", "lv-chip", "Next →");
    prev.type = next.type = "button";
    prev.disabled = graphTablePage.offset === 0;
    next.disabled = graphTablePage.offset + graphTablePage.limit >= body.total;
    prev.addEventListener("click", () => { graphTablePage.offset = Math.max(0, graphTablePage.offset - graphTablePage.limit); renderGraphTablePage(); });
    next.addEventListener("click", () => { graphTablePage.offset += graphTablePage.limit; renderGraphTablePage(); });
    pager.appendChild(prev);
    pager.appendChild(next);
  }
}

/* ------------------------------------------------------------------ */
/* Health cards (Insights tab)                                         */
/* ------------------------------------------------------------------ */

/**
 * Cross-view navigation: writes the route (so the URL stays shareable and
 * back returns here), switches tab, and REPLACES the target list's filter.
 */
function navigate({ tab, filter }) {
  route({ tab, filter, sel: undefined, anchor: undefined, view: undefined }, { push: true });
  if (typeof window.switchTab === "function") window.switchTab(tab);
  requestAnimationFrame(() => {
    const scoped = { ...(filter || {}), scope: scopeNav ? scopeNav.getScope() || undefined : undefined };
    if (tab === "blackboard" && blackboardList) blackboardList.setFilter(scoped, { replace: true });
    if (tab === "decisions" && decisionsList) decisionsList.setFilter(scoped, { replace: true });
  });
}

/** Cross-link resolution for legacy navigateToId (app.js delegates here). */
window.__twiningNavigateToId = (id) => {
  const row = store.rows.find((r) => r.id === id);
  if (row) {
    const tab = row.kind === "blackboard" ? "blackboard" : "decisions";
    // Single history entry, and no filter replace — the user's facets on the
    // destination list survive a cross-link jump (re-review R2).
    route({ tab, sel: id, anchor: undefined, view: undefined }, { push: true });
    if (typeof window.switchTab === "function") window.switchTab(tab);
    requestAnimationFrame(() => {
      if (row.kind === "blackboard") showBlackboardDetail(row);
      else showDecisionDetail(row);
    });
    return true;
  }
  // Not in the index: probe for a graph entity before moving the user
  // anywhere — an unresolvable id keeps them where they are with an inline
  // message instead of yanking them to the Graph tab (re-review R1).
  (async () => {
    try {
      const res = await fetch(`/api/graph/neighborhood?id=${encodeURIComponent(id)}&depth=1&limit=1`);
      if (res.ok) {
        exploreInGraph(id);
        if (typeof window.switchTab === "function") window.switchTab("graph");
        route({ tab: "graph", view: "visual", anchor: id, sel: undefined }, { push: true });
        return;
      }
    } catch {
      /* fall through to the inline message */
    }
    const bar = document.getElementById("search-status-bar");
    if (bar) {
      clearElement(bar);
      bar.appendChild(el("span", null, `ID not found: ${id}`));
    }
  })();
  return true;
};

function mountHealth() {
  const host = document.getElementById("health-cards");
  if (host) renderHealthCards(host, navigate);
}

/* ------------------------------------------------------------------ */
/* Scope breadcrumb (header)                                           */
/* ------------------------------------------------------------------ */

let scopeNav = null;

function setGlobalScope(scope) {
  route({ scope: scope || undefined });
  // New views
  const patch = { scope: scope || undefined };
  if (blackboardList) blackboardList.setFilter(patch);
  if (decisionsList) decisionsList.setFilter(patch);
  if (timeline) timeline.setFilter(patch);
  if (timelineSyncedList) timelineSyncedList.setFilter(patch);
  // Legacy views (search/agents) read state.globalScope via applyGlobalScope
  if (window.state) {
    window.state.globalScope = scope;
    if (typeof window.refreshData === "function") window.refreshData();
  }
}

function mountScopeNav() {
  const host = document.getElementById("scope-breadcrumb");
  if (!host || scopeNav) return;
  scopeNav = createScopeNav(host, { store, onChange: setGlobalScope });
}

/* ------------------------------------------------------------------ */
/* Boot + polling                                                      */
/* ------------------------------------------------------------------ */

function activeTab() {
  const btn = document.querySelector(".tab-btn.active");
  return btn ? btn.getAttribute("data-tab") : "stats";
}

/** Drive the views from a route object (initial load, back/forward). */
function applyRoute(r) {
  applyingRoute = true;
  try {
    if (r.tab && typeof window.switchTab === "function") window.switchTab(r.tab);
    if (r.view === "timeline" && typeof window.toggleView === "function") window.toggleView("decisions", "timeline");
    if (r.view === "visual" && typeof window.toggleView === "function") window.toggleView("graph", "visual");
    if (scopeNav) scopeNav.setScope(r.scope || "");
    // REPLACE filters (base + route filter + scope) so back/forward can clear
    // facets, not only add them (final-review finding I3).
    const routeFilter = { ...(r.filter || {}), scope: r.scope || undefined };
    if (r.tab === "blackboard" && blackboardList) blackboardList.setFilter(routeFilter, { replace: true });
    if (r.tab === "decisions" && decisionsList) decisionsList.setFilter(routeFilter, { replace: true });
    if (r.tab === "triage" && triageView) triageView.refresh();
    if (r.range && timeline) timeline.setRange(r.range.fromMs, r.range.toMs);
    if (r.anchor) {
      requestAnimationFrame(() => {
        if (graphView) graphView.focus(r.anchor);
      });
    }
    if (r.sel) {
      const row = store.rows.find((row) => row.id === r.sel);
      if (row) {
        if (row.kind === "blackboard") showBlackboardDetail(row);
        else showDecisionDetail(row, r.view === "timeline" ? "decisions-timeline-detail" : "decisions-detail");
      }
    }
  } finally {
    applyingRoute = false;
  }
}

async function boot() {
  try {
    await store.load();
  } catch {
    // Connection banner is app.js's job; the store retries on next poll.
  }
  mountBlackboard();
  mountDecisions();
  mountTriage();
  mountScopeNav();

  // Stats-tab activity renders now read the compact index (C1): re-render
  // them whenever the store changes, replacing the old fetchBlackboard tie.
  const renderStats = () => {
    if (typeof window.renderActivityBreakdown === "function") window.renderActivityBreakdown();
    if (typeof window.renderRecentActivity === "function") window.renderRecentActivity();
  };
  store.subscribe(renderStats);
  renderStats();

  document.addEventListener("click", (evt) => {
    const btn = evt.target.closest && evt.target.closest(".tab-btn");
    if (!btn) return;
    // Re-render the freshly shown tab: virtualized viewports measure 0 while hidden.
    requestAnimationFrame(() => {
      const tab = btn.getAttribute("data-tab");
      route({ tab, sel: undefined, filter: undefined, anchor: undefined, view: undefined }, { push: true });
      if (tab === "blackboard" && blackboardList) blackboardList.refresh();
      if (tab === "decisions" && decisionsList) decisionsList.refresh();
      if (tab === "triage" && triageView) triageView.refresh();
      if (tab === "graph") {
        renderGraphTablePage();
        const visual = document.getElementById("graph-visual-view");
        if (visual && visual.style.display !== "none") window.__twiningGraphShown();
      }
      if (tab === "insights") mountHealth();
    });
  });
  renderGraphTablePage();

  // Apply a deep-link route (reload / shared URL), then follow back/forward.
  const initial = readRoute();
  if (initial) {
    syncCurrent(initial);
    applyRoute(initial);
  }
  onRouteChange(applyRoute);

  setInterval(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) return;
      await store.poll(await res.json());
    } catch {
      /* offline; app.js banner handles messaging */
    }
  }, POLL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
