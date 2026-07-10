/**
 * URL hash routing — shareable, reload-safe view state.
 * Format: #/<tab>?view=&scope=&f=<encoded json filter>&sel=&range=<from>-<to>&anchor=
 * pushState for tab/selection/anchor changes (back button = previous view),
 * replaceState for filter/range tweaks.
 */

/** Allowlisted filter keys and their expected shapes — everything else in a
 * hand-crafted f= param (including __proto__) is dropped on the floor. */
const FILTER_KEYS = {
  entryTypes: "array",
  statuses: "array",
  domains: "array",
  confidences: "array",
  tags: "array",
  text: "string",
  from: "string",
  to: "string",
};

function sanitizeFilter(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [key, shape] of Object.entries(FILTER_KEYS)) {
    const value = raw[key];
    if (shape === "array" && Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[key] = value;
    } else if (shape === "string" && typeof value === "string" && value) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function readRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return null;
  const [tab, query] = hash.split("?");
  const params = new URLSearchParams(query || "");
  let filter;
  try {
    filter = params.get("f") ? sanitizeFilter(JSON.parse(decodeURIComponent(params.get("f")))) : undefined;
  } catch {
    filter = undefined;
  }
  let range;
  const rangeRaw = params.get("range");
  if (rangeRaw && /^\d+-\d+$/.test(rangeRaw)) {
    const [from, to] = rangeRaw.split("-").map(Number);
    range = { fromMs: from, toMs: to };
  }
  return {
    tab: tab || "stats",
    view: params.get("view") || undefined,
    scope: params.get("scope") || undefined,
    filter,
    sel: params.get("sel") || undefined,
    range,
    anchor: params.get("anchor") || undefined,
  };
}

let current = {};

export function writeRoute(partial, { push = false } = {}) {
  current = { ...current, ...partial };
  for (const key of Object.keys(current)) {
    if (current[key] === undefined || current[key] === null) delete current[key];
  }
  const params = new URLSearchParams();
  if (current.view) params.set("view", current.view);
  if (current.scope) params.set("scope", current.scope);
  if (current.filter && Object.keys(current.filter).length) {
    params.set("f", encodeURIComponent(JSON.stringify(current.filter)));
  }
  if (current.sel) params.set("sel", current.sel);
  if (current.range) params.set("range", `${Math.round(current.range.fromMs)}-${Math.round(current.range.toMs)}`);
  if (current.anchor) params.set("anchor", current.anchor);
  const query = params.toString();
  const hash = `#/${current.tab || "stats"}${query ? "?" + query : ""}`;
  if (hash === window.location.hash) return;
  if (push) history.pushState(null, "", hash);
  else history.replaceState(null, "", hash);
}

export function onRouteChange(fn) {
  window.addEventListener("popstate", () => {
    const route = readRoute();
    if (route) {
      current = { ...route };
      fn(route);
    }
  });
}

/** Seed the module's internal state from the current URL (call at boot). */
export function syncCurrent(route) {
  current = { ...(route || {}) };
}
