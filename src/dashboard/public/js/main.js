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

  document.addEventListener("click", (evt) => {
    const btn = evt.target.closest && evt.target.closest(".tab-btn");
    if (!btn) return;
    // Re-render the freshly shown tab: virtualized viewports measure 0 while hidden.
    requestAnimationFrame(() => {
      if (btn.getAttribute("data-tab") === "blackboard" && blackboardList) blackboardList.refresh();
    });
  });

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
