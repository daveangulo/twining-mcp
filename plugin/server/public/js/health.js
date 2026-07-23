/**
 * Health cards for the Insights tab — driven by /api/health-report.
 * Each card previews the top offenders and deep-links to the relevant
 * pre-filtered view via the navigate() helper handed in by main.js
 * (rerouted through hash routing once router.js lands).
 */
import { el, clearElement } from "./util.js";

const CARDS = [
  {
    key: "stale_decisions",
    title: "Stale decision candidates",
    empty: "No stale candidates — scopes and files all resolve.",
    row: (item) => `${item.summary} · ${item.scope}`,
    nav: (navigate) => navigate({ tab: "decisions", filter: { statuses: ["active"] } }),
  },
  {
    key: "unresolved_warnings",
    title: "Unresolved warnings",
    empty: "No open warnings.",
    row: (item) => `${item.summary} · ${item.age_days}d old`,
    nav: (navigate) => navigate({ tab: "blackboard", filter: { entryTypes: ["warning"] } }),
  },
  {
    key: "superseded_chains",
    title: "Supersession chains",
    empty: "No supersession chains.",
    row: (item) => `${item.head_summary} · length ${item.length}`,
    nav: (navigate) => navigate({ tab: "decisions", filter: { statuses: ["superseded"] } }),
  },
  {
    key: "orphan_entities",
    title: "Orphaned graph entities",
    empty: "Every entity is connected.",
    count: (data) => data.orphan_entities.count,
    rows: (data) => (data.orphan_entities.sample || []).slice(0, 3).map((s) => `${s.name} (${s.type})`),
    nav: (navigate) => navigate({ tab: "graph" }),
  },
  {
    key: "unacknowledged_handoffs",
    title: "Unacknowledged handoffs",
    empty: "All handoffs acknowledged.",
    row: (item) => `${item.summary} · ${item.age_days}d`,
    nav: (navigate) => navigate({ tab: "agents" }),
  },
];

export async function renderHealthCards(host, navigate) {
  let data;
  try {
    const res = await fetch("/api/health-report");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    clearElement(host);
    host.appendChild(el("p", "placeholder", "Health report unavailable."));
    return;
  }

  clearElement(host);
  for (const def of CARDS) {
    const items = Array.isArray(data[def.key]) ? data[def.key] : null;
    const count = def.count ? def.count(data) : items.length;
    const card = el("button", "insight-card health-card");
    card.type = "button";
    card.appendChild(el("div", "insight-label", def.title));
    const value = el("div", "insight-value", String(count));
    if (count > 0) value.classList.add("health-attention");
    card.appendChild(value);
    const previewRows = def.rows ? def.rows(data) : (items || []).slice(0, 3).map(def.row);
    if (previewRows.length === 0) {
      card.appendChild(el("div", "insight-detail", def.empty));
    } else {
      for (const text of previewRows) card.appendChild(el("div", "insight-detail health-row", text));
    }
    card.addEventListener("click", () => def.nav(navigate));
    host.appendChild(card);
  }
}
