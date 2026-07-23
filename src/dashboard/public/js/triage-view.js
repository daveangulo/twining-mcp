/**
 * Triage tab view (TRIAGE-SPEC §8).
 *
 * Unlike list-view, this view does not render from the client index store —
 * it fetches GET /api/triage itself. Refresh wiring: fetch once on mount;
 * change-gated refetch via store.subscribe (quiet store ⇒ no refetch);
 * refetch on tab activation (main.js calls refresh()). No bespoke
 * setInterval — the two time-based exits (window expiry, delegation expiry)
 * go stale between store changes / activations; accepted v1 staleness.
 *
 * createTriageView(container, { store, onSelect, fetchImpl })
 * returns { refresh, destroy }
 */
import { el, clearElement } from "./util.js";

/** Compact relative age for row display ("5m", "3h", "12d"). */
export function formatAge(ageMs) {
  if (typeof ageMs !== "number" || !isFinite(ageMs) || ageMs < 0) return "--";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * NORMATIVE truncation indicator (§8): rendered whenever the pre-truncation
 * total exceeds the delivered array length. Returns null when complete.
 */
export function truncationLabel(bucketCounts, shown) {
  if (!bucketCounts || bucketCounts.total <= shown) return null;
  return `showing ${shown} of ${bucketCounts.total}`;
}

/**
 * §8 deep-link rule: id + kind are sufficient — decisions route to the
 * Decisions tab, every blackboard kind to the Blackboard tab. main.js uses
 * this to route triage clicks without a client-index lookup.
 */
export function deepLinkTab(kind) {
  return kind === "decision" ? "decisions" : "blackboard";
}

/** Deep link via the existing sel= hash mechanism (js/router.js). */
export function deepLinkHash(item) {
  return `#/${deepLinkTab(item.kind)}?sel=${encodeURIComponent(item.id)}`;
}

/**
 * Badges per §8: reversible/confidence/status on decisions, urgency on
 * delegation needs. Classes reuse the existing .badge palette in style.css.
 */
export function itemBadges(item) {
  const badges = [];
  if (item.kind === "decision") {
    if (item.status) badges.push({ label: item.status, cls: item.status });
    if (item.confidence) badges.push({ label: item.confidence, cls: item.confidence });
    if (item.reversible === false) badges.push({ label: "irreversible", cls: "urgency-high" });
  } else if (item.kind === "need" && item.urgency) {
    badges.push({ label: `${item.urgency} urgency`, cls: `urgency-${item.urgency}` });
  }
  return badges;
}

/**
 * Client-side visual grouping (§8 SHOULD): irreversible decisions first,
 * then provisional decisions, then the rest — stable within groups, so the
 * API's §4.2 ordering is preserved inside each band.
 */
export function groupRows(items) {
  const rank = (item) => {
    if (item.kind !== "decision") return 2;
    if (item.reversible === false) return 0;
    return item.status === "provisional" ? 1 : 2;
  };
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
    .map((x) => x.item);
}

/**
 * DOM-stability key for a /api/triage response body: strips the per-call
 * clock fields (generated_at, every item's age_ms) so identical store state
 * yields an identical key — everything else is a pure function of the
 * stores per the §4.2 clock-free ordering. A raw byte-compare would never
 * match: generated_at and age_ms advance on every call.
 */
export function stableKey(text) {
  try {
    const body = JSON.parse(text);
    delete body.generated_at;
    for (const bucket of [body.open, body.recent]) {
      if (Array.isArray(bucket)) for (const item of bucket) delete item.age_ms;
    }
    return JSON.stringify(body);
  } catch {
    return text;
  }
}

export function createTriageView(container, opts = {}) {
  const { store, onSelect, fetchImpl } = opts;
  const doFetch = fetchImpl || ((url) => globalThis.fetch(url));

  /* ---------- Skeleton ---------- */
  const openSection = el("div", "stats-section");
  const openHeader = el("div", "activity-entry-header");
  openHeader.appendChild(el("h2", "stats-section-title", "Open items"));
  const openCount = el("span", "lv-count");
  openHeader.appendChild(openCount);
  const openList = el("div", "recent-activity");
  openSection.appendChild(openHeader);
  openSection.appendChild(openList);

  const recentSection = el("div", "stats-section");
  const recentDetails = document.createElement("details");
  recentDetails.open = true;
  const recentSummary = document.createElement("summary");
  recentSummary.className = "stats-section-title";
  recentSummary.appendChild(document.createTextNode("Recent activity "));
  const recentCount = el("span", "lv-count");
  recentSummary.appendChild(recentCount);
  const recentList = el("div", "recent-activity");
  recentDetails.appendChild(recentSummary);
  recentDetails.appendChild(recentList);
  recentSection.appendChild(recentDetails);

  container.appendChild(openSection);
  container.appendChild(recentSection);

  /* ---------- Rendering ---------- */
  function renderRow(item) {
    const row = el("div", "activity-entry");
    row.style.cursor = "pointer";
    const header = el("div", "activity-entry-header");
    const left = el("span");
    left.appendChild(el("span", "activity-entry-type", item.kind));
    left.appendChild(document.createTextNode(" "));
    left.appendChild(el("span", "lv-chip", item.scope));
    for (const badge of itemBadges(item)) {
      left.appendChild(document.createTextNode(" "));
      left.appendChild(el("span", `badge ${badge.cls}`, badge.label));
    }
    header.appendChild(left);
    header.appendChild(el("span", "activity-entry-time", `${formatAge(item.age_ms)} · ${item.agent_id}`));
    row.appendChild(header);
    row.appendChild(el("div", "activity-entry-summary", item.summary));
    row.addEventListener("click", () => {
      if (onSelect) onSelect(item);
    });
    return row;
  }

  function renderPanel(listEl, countEl, items, bucketCounts, emptyText) {
    clearElement(listEl);
    countEl.textContent = truncationLabel(bucketCounts, items.length) || "";
    if (items.length === 0) {
      listEl.appendChild(el("p", "placeholder", emptyText));
      return;
    }
    for (const item of groupRows(items)) listEl.appendChild(renderRow(item));
  }

  function render(body) {
    renderPanel(openList, openCount, body.open || [], body.counts.open, "No open items — nothing is awaiting a lifecycle act.");
    renderPanel(recentList, recentCount, body.recent || [], body.counts.recent, "No recent activity in the window.");
  }

  function renderError() {
    lastKey = null; // a recovered fetch must re-render even if state-identical
    clearElement(openList);
    clearElement(recentList);
    openCount.textContent = "";
    recentCount.textContent = "";
    openList.appendChild(el("p", "placeholder", "Could not load triage data."));
  }

  /* ---------- Fetch (mount / store change / tab activation) ---------- */
  let inFlight = false;
  let lastKey = null;
  let destroyed = false;

  async function refresh() {
    if (inFlight || destroyed) return;
    inFlight = true;
    try {
      const res = await doFetch("/api/triage");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (destroyed) return;
      const key = stableKey(text);
      if (key === lastKey) return; // unchanged store state — keep the DOM stable
      lastKey = key;
      render(JSON.parse(text));
    } catch {
      if (!destroyed) renderError();
    } finally {
      inFlight = false;
    }
  }

  const unsubscribe = store ? store.subscribe(refresh) : () => {};
  refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      unsubscribe();
      clearElement(container);
    },
  };
}
