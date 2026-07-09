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
    val.appendChild(el("pre", null, String(value)));
  } else {
    val.textContent = String(value);
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
    onSelect: showBlackboardDetail,
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
    onSelect: showDecisionDetail,
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
  const host = document.getElementById("graph-canvas");
  if (!host) return;
  if (!graphView) graphView = createGraphView(host, {});
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
 * Cross-view navigation: switch tab (via legacy switchTab global) and apply
 * a filter to the target list view. router.js reroutes this through the URL
 * hash when it lands (Task 16).
 */
function navigate({ tab, filter }) {
  if (typeof window.switchTab === "function") window.switchTab(tab);
  requestAnimationFrame(() => {
    if (tab === "blackboard" && blackboardList && filter) blackboardList.setFilter(filter);
    if (tab === "decisions" && decisionsList && filter) decisionsList.setFilter(filter);
  });
}

function mountHealth() {
  const host = document.getElementById("health-cards");
  if (host) renderHealthCards(host, navigate);
}

/* ------------------------------------------------------------------ */
/* Scope breadcrumb (header)                                           */
/* ------------------------------------------------------------------ */

let scopeNav = null;

function setGlobalScope(scope) {
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

async function boot() {
  try {
    await store.load();
  } catch {
    // Connection banner is app.js's job; the store retries on next poll.
  }
  mountBlackboard();
  mountDecisions();
  mountScopeNav();

  document.addEventListener("click", (evt) => {
    const btn = evt.target.closest && evt.target.closest(".tab-btn");
    if (!btn) return;
    // Re-render the freshly shown tab: virtualized viewports measure 0 while hidden.
    requestAnimationFrame(() => {
      const tab = btn.getAttribute("data-tab");
      if (tab === "blackboard" && blackboardList) blackboardList.refresh();
      if (tab === "decisions" && decisionsList) decisionsList.refresh();
      if (tab === "graph") {
        renderGraphTablePage();
        const visual = document.getElementById("graph-visual-view");
        if (visual && visual.style.display !== "none") window.__twiningGraphShown();
      }
      if (tab === "insights") mountHealth();
    });
  });
  renderGraphTablePage();

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
