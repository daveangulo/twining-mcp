/**
 * Compact client-side index store for the Twining dashboard.
 *
 * Holds one lightweight row per blackboard entry and decision (from
 * /api/index), refreshed by delta polling. All facet counting, filtering,
 * and scope rollups happen here, in memory — views never fetch datasets.
 *
 * Pure ESM with no DOM access so the logic is unit-testable in vitest.
 */

/** Facet filter field -> row property. `tags` is multi-valued. */
const FACET_FIELDS = {
  kinds: "kind",
  entryTypes: "entry_type",
  statuses: "status",
  domains: "domain",
  confidences: "confidence",
  tags: "tags",
};

function rowMatches(row, f) {
  for (const [filterKey, prop] of Object.entries(FACET_FIELDS)) {
    const wanted = f[filterKey];
    if (!wanted || wanted.length === 0) continue;
    if (prop === "tags") {
      const tags = row.tags || [];
      if (!wanted.some((t) => tags.includes(t))) return false;
    } else if (!wanted.includes(row[prop])) {
      return false;
    }
  }
  if (f.scope && !row.scope.startsWith(f.scope)) return false;
  if (f.from && row.timestamp < f.from) return false;
  if (f.to && row.timestamp > f.to) return false;
  if (f.text) {
    const needle = f.text.toLowerCase();
    if (!row.summary.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** Compare per-kind / per-status counts generically against server totals. */
function countsMatch(rows, serverCounts) {
  if (!serverCounts) return true;
  let blackboard = 0;
  const decisions = {};
  for (const r of rows) {
    if (r.kind === "blackboard") blackboard++;
    else decisions[r.status] = (decisions[r.status] || 0) + 1;
  }
  if (blackboard !== serverCounts.blackboard) return false;
  const serverDec = serverCounts.decisions || {};
  // Iterate the UNION of keys — a status present on only one side is a mismatch.
  const keys = new Set([...Object.keys(decisions), ...Object.keys(serverDec)]);
  for (const k of keys) {
    if ((decisions[k] || 0) !== (serverDec[k] || 0)) return false;
  }
  return true;
}

export function createIndexStore({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((url) => globalThis.fetch(url));
  const subscribers = new Set();

  const store = {
    rows: [],
    counts: { blackboard: 0, decisions: {} },
    initialized: false,

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    async load() {
      const res = await doFetch("/api/index");
      const body = await res.json();
      store.rows = (body.rows || []).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      store.counts = body.total_counts || { blackboard: 0, decisions: {} };
      store.initialized = body.initialized !== false;
      notify();
    },

    /**
     * Cheap change detection from the /api/status body. Only the fields the
     * status endpoint actually carries are compared (blackboard total,
     * active/provisional decision counts, last_activity); anything those
     * can't see (e.g. superseded -> archived flips with no other activity)
     * is caught by the post-merge count validation on the NEXT real change.
     */
    async poll(status) {
      if (!status) return;
      const local = localSignature(store);
      if (
        status.blackboard_entries === local.blackboard &&
        status.active_decisions === local.active &&
        status.provisional_decisions === local.provisional &&
        (status.last_activity === local.latest || status.last_activity === "none")
      ) {
        return; // nothing changed
      }

      const latest = store.rows.length ? store.rows[store.rows.length - 1].timestamp : "";
      const url = latest ? "/api/index?since=" + encodeURIComponent(latest) : "/api/index";
      const res = await doFetch(url);
      const body = await res.json();

      // Merge: dedupe by id, delta rows win.
      const byId = new Map(store.rows.map((r) => [r.id, r]));
      for (const r of body.rows || []) byId.set(r.id, r);
      const merged = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      if (countsMatch(merged, body.total_counts)) {
        store.rows = merged;
        store.counts = body.total_counts || store.counts;
        notify();
      } else {
        // Mutation invisible to the timestamp delta (status flip, archival,
        // dismissal). One full refetch — never a loop: load() replaces
        // wholesale and does not re-validate.
        await store.load();
      }
    },

    filter(f = {}) {
      return store.rows.filter((r) => rowMatches(r, f));
    },

    /**
     * Counts of `field` values with `f` applied EXCEPT the filter entry for
     * that field (standard faceted-search semantics: a facet never narrows
     * its own option counts). Rows lacking the field are skipped.
     */
    facetCounts(f = {}, field) {
      const relaxed = { ...f };
      for (const [filterKey, prop] of Object.entries(FACET_FIELDS)) {
        if (prop === field) delete relaxed[filterKey];
      }
      const counts = new Map();
      for (const row of store.filter(relaxed)) {
        const value = row[field];
        if (value === undefined || value === null) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
      }
      return counts;
    },

    /**
     * Direct scope children of `prefix` for rows matching `f` (its own scope
     * entry ignored). A child segment ends at the next "/" (inclusive) or the
     * end of the scope string ("project" -> segment "project").
     */
    scopeChildren(f = {}, prefix = "") {
      const relaxed = { ...f };
      delete relaxed.scope;
      const counts = new Map();
      for (const row of store.filter(relaxed)) {
        if (!row.scope.startsWith(prefix) || row.scope === prefix) continue;
        const rest = row.scope.slice(prefix.length);
        const slash = rest.indexOf("/");
        const segment = slash === -1 ? rest : rest.slice(0, slash + 1);
        counts.set(segment, (counts.get(segment) || 0) + 1);
      }
      return [...counts.entries()]
        .map(([segment, count]) => ({ segment, scope: prefix + segment, count }))
        .sort((a, b) => b.count - a.count || a.segment.localeCompare(b.segment));
    },
  };

  function localSignature(s) {
    let blackboard = 0;
    let active = 0;
    let provisional = 0;
    for (const r of s.rows) {
      if (r.kind === "blackboard") blackboard++;
      else if (r.status === "active") active++;
      else if (r.status === "provisional") provisional++;
    }
    return {
      blackboard,
      active,
      provisional,
      latest: s.rows.length ? s.rows[s.rows.length - 1].timestamp : "none",
    };
  }

  function notify() {
    for (const fn of subscribers) fn();
  }

  return store;
}
