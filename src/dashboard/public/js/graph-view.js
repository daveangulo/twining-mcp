/**
 * Drill-down graph explorer (cytoscape). Replaces the render-everything view.
 *
 * Level 0 — overview: one node per entity type from /api/graph/summary
 *   (always ~10 nodes, readable at any project size), hubs + orphans panel.
 * Level 1 — entity list: click a type node -> searchable paged list.
 * Level 2 — ego: /api/graph/neighborhood around one anchor, <=150 nodes,
 *   per-type overflow chips page in more, tap re-anchors with a breadcrumb
 *   trail, visible nodes hard-capped at 200 via lowest-degree eviction.
 */
import { el, clearElement } from "./util.js";

const ENTITY_COLORS = {
  module: "#3b82f6",
  function: "#8b5cf6",
  class: "#06b6d4",
  file: "#6b7280",
  concept: "#f59e0b",
  pattern: "#10b981",
  dependency: "#ef4444",
  api_endpoint: "#ec4899",
  agent: "#14b8a6",
  commit: "#a855f7",
};
const NODE_CAP = 200;
const EGO_LIMIT = 150;
const PAGE_IN = 20;

function cyStyles() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const textColor = isDark ? "#c8d0e0" : "#1a1a2e";
  const halo = isDark ? "rgba(11, 15, 26, 0.85)" : "rgba(255, 255, 255, 0.85)";
  const edgeColor = isDark ? "rgba(100, 116, 139, 0.5)" : "rgba(148, 163, 184, 0.6)";
  const edgeLabel = isDark ? "#64748b" : "#94a3b8";
  const accent = isDark ? "#00d4aa" : "#00a88a";

  const styles = [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "text-valign": "bottom",
        "text-halign": "center",
        "font-size": "10px",
        "font-weight": 500,
        width: "data(size)",
        height: "data(size)",
        color: textColor,
        "text-margin-y": 6,
        "background-color": "#6b7280",
        "background-opacity": 0.9,
        "border-width": 2,
        "border-color": "rgba(255,255,255,0.08)",
        "text-wrap": "ellipsis",
        "text-max-width": "110px",
        "text-background-opacity": 0.8,
        "text-background-color": halo,
        "text-background-padding": "2px",
        "text-background-shape": "roundrectangle",
        "overlay-opacity": 0,
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        "line-color": edgeColor,
        "target-arrow-color": edgeColor,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": "bezier",
        label: "data(label)",
        "font-size": "8px",
        color: edgeLabel,
        "text-rotation": "autorotate",
        "text-background-opacity": 0.75,
        "text-background-color": halo,
        "text-background-padding": "1px",
        "text-background-shape": "roundrectangle",
        opacity: 0.7,
      },
    },
    { selector: "node:selected", style: { "border-width": 3, "border-color": accent, "background-opacity": 1, "z-index": 10 } },
    { selector: "node.anchor", style: { "border-width": 4, "border-color": accent, "z-index": 10 } },
    {
      selector: "node.chip",
      style: {
        shape: "round-rectangle",
        "background-opacity": 0.25,
        "border-style": "dashed",
        "border-color": accent,
        color: textColor,
        "text-valign": "center",
        "text-margin-y": 0,
        width: "label",
        height: 22,
        "padding": "6px",
        "font-size": "9px",
      },
    },
  ];
  for (const [type, color] of Object.entries(ENTITY_COLORS)) {
    styles.push({ selector: `node[type="${type}"]`, style: { "background-color": color } });
  }
  return styles;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function createGraphView(container, opts = {}) {
  const state = {
    level: "overview",
    anchor: null,
    trail: [], // anchor history for breadcrumb
    shown: new Map(), // ego: `${from}:${type}` -> count paged in beyond initial
    summary: null,
  };

  const crumbHost = document.getElementById("graph-type-filters"); // reused as breadcrumb/level bar
  const legendHost = document.getElementById("graph-legend");
  const detailHost = document.getElementById("graph-visual-detail");

  let cy = null;

  function toast(msg) {
    const t = el("div", "dt-toast", msg);
    container.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function makeCy(elements, layout) {
    if (cy) cy.destroy();
    cy = cytoscape({
      container,
      elements,
      layout,
      style: cyStyles(),
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 0.3,
      pixelRatio: "auto",
    });
    cy.on("tap", "node", (evt) => onTap(evt.target));
    window.__twiningCy = cy; // debug/verification handle (plan Task 13)
    return cy;
  }

  /* ---------------- Level 0: overview ---------------- */

  async function showOverview() {
    state.level = "overview";
    state.anchor = null;
    state.trail = [];
    let summary;
    try {
      summary = await getJSON("/api/graph/summary");
    } catch {
      toast("Could not load graph summary");
      return;
    }
    state.summary = summary;
    const elements = [];
    for (const g of summary.groups) {
      elements.push({
        data: { id: `type:${g.type}`, label: `${g.type} (${g.count})`, type: g.type, size: 28 + Math.sqrt(g.count) * 3, group: true },
      });
    }
    for (const e of summary.group_edges || []) {
      if (e.source_type === e.target_type) continue; // self-loops clutter the circle
      elements.push({
        data: {
          id: `ge:${e.source_type}:${e.target_type}`,
          source: `type:${e.source_type}`,
          target: `type:${e.target_type}`,
          label: String(e.total),
          width: 1 + Math.log2(1 + e.total),
        },
      });
    }
    makeCy(elements, { name: "circle", padding: 60 });
    renderCrumbs();
    renderLegend();
    renderOverviewPanel(summary);
  }

  function renderOverviewPanel(summary) {
    if (!detailHost) return;
    clearElement(detailHost);
    detailHost.appendChild(el("h3", null, "Knowledge Graph"));
    const stats = el("div", "detail-field");
    stats.appendChild(el("div", "detail-label", "Totals"));
    stats.appendChild(el("div", "detail-value", `${summary.entity_count} entities · ${summary.relation_count} relations · ${summary.orphan_count} orphans`));
    detailHost.appendChild(stats);

    detailHost.appendChild(el("h3", null, "Top hubs"));
    const list = el("div", "gv-hubs");
    for (const hub of summary.hubs || []) {
      const row = el("button", "gv-hub-row");
      row.type = "button";
      const dot = el("span", "dt-swatch");
      dot.style.background = ENTITY_COLORS[hub.type] || "#6b7280";
      row.appendChild(dot);
      row.appendChild(el("span", "gv-hub-name", hub.name));
      row.appendChild(el("span", "gv-hub-degree", `${hub.degree}`));
      row.addEventListener("click", () => showEgo(hub.id));
      list.appendChild(row);
    }
    detailHost.appendChild(list);
    detailHost.appendChild(el("p", "placeholder", "Click a type bubble for its entities; click a hub to explore its neighborhood."));
  }

  /* ---------------- Level 1: entity list ---------------- */

  async function showEntityList(type) {
    if (!detailHost) return;
    clearElement(detailHost);
    detailHost.appendChild(el("h3", null, `${type} entities`));
    const search = el("input", "lv-search");
    search.type = "search";
    search.placeholder = `Search ${type} names…`;
    detailHost.appendChild(search);
    const list = el("div", "gv-hubs");
    detailHost.appendChild(list);
    const more = el("button", "lv-chip", "Load more");
    more.type = "button";
    detailHost.appendChild(more);

    let offset = 0;
    let q = "";
    async function loadPage(reset) {
      if (reset) {
        offset = 0;
        clearElement(list);
      }
      let body;
      try {
        body = await getJSON(`/api/graph/entities?type=${encodeURIComponent(type)}&offset=${offset}&limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`);
      } catch {
        toast("Could not load entities");
        return;
      }
      for (const ent of body.entities) {
        const row = el("button", "gv-hub-row");
        row.type = "button";
        row.appendChild(el("span", "gv-hub-name", ent.name));
        row.appendChild(el("span", "gv-hub-degree", `${ent.degree}`));
        row.addEventListener("click", () => showEgo(ent.id));
        list.appendChild(row);
      }
      offset += body.entities.length;
      more.style.display = offset < body.total ? "" : "none";
      more.textContent = `Load more (${offset}/${body.total})`;
    }
    let debounceTimer = null;
    search.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        q = search.value.trim();
        loadPage(true);
      }, 200);
    });
    more.addEventListener("click", () => loadPage(false));
    await loadPage(true);
  }

  /* ---------------- Level 2: ego ---------------- */

  async function showEgo(anchorId, pushTrail = true) {
    let body;
    try {
      body = await getJSON(`/api/graph/neighborhood?id=${encodeURIComponent(anchorId)}&depth=1&limit=${EGO_LIMIT}`);
    } catch (err) {
      if (err.status === 404) {
        toast("Entity no longer exists — returning to overview");
        showOverview();
      } else {
        toast("Could not load neighborhood");
      }
      return;
    }
    if (pushTrail && state.anchor && state.anchor !== anchorId) state.trail.push(state.anchor);
    state.level = "ego";
    state.anchor = anchorId;
    state.shown = new Map();

    const elements = [];
    for (const ent of body.entities) {
      elements.push({
        data: { id: ent.id, label: ent.name, type: ent.type, size: ent.id === anchorId ? 44 : 26 + Math.min(Math.sqrt(ent.degree || 1) * 2, 14), degree: ent.degree || 0 },
        classes: ent.id === anchorId ? "anchor" : "",
      });
    }
    for (const rel of body.relations) {
      elements.push({ data: { id: rel.id, source: rel.source, target: rel.target, label: rel.type || "", width: 1.5 } });
    }
    for (const ov of body.overflow || []) {
      elements.push({
        data: { id: `chip:${ov.from}:${ov.type}`, label: `+${ov.omitted} ${ov.type}`, type: ov.type, size: 22, chip: true, from: ov.from, chipType: ov.type, omitted: ov.omitted },
        classes: "chip",
      });
      elements.push({ data: { id: `chipedge:${ov.from}:${ov.type}`, source: ov.from, target: `chip:${ov.from}:${ov.type}`, label: "", width: 1 } });
    }
    makeCy(elements, { name: "concentric", padding: 40, concentric: (n) => (n.id() === anchorId ? 2 : 1), levelWidth: () => 1, minNodeSpacing: 24 });
    renderCrumbs();
    renderLegend();
    renderEgoDetail(body.entities.find((e) => e.id === anchorId));
  }

  async function pageInChip(chipNode) {
    const from = chipNode.data("from");
    const type = chipNode.data("chipType");
    const key = `${from}:${type}`;
    // Initial ego already showed some of this type; page from what's on
    // screen. Exclude `from` itself: the server pages NEIGHBORS of `from`,
    // which never include it — counting it skips one neighbor forever when
    // the anchor shares the chip's type (final-review finding I1).
    const shownOfType = cy.nodes(`[type="${type}"]`).filter((n) => !n.data("chip") && n.id() !== from).length;
    const offset = (state.shown.get(key) || shownOfType);
    let body;
    try {
      body = await getJSON(`/api/graph/neighborhood?id=${encodeURIComponent(from)}&type=${encodeURIComponent(type)}&offset=${offset}&limit=${PAGE_IN}`);
    } catch {
      toast("Could not page in more nodes");
      return;
    }
    state.shown.set(key, offset + body.entities.length);

    // Evict lowest-degree non-anchor leaves to stay under the cap.
    const incoming = body.entities.filter((e) => !cy.getElementById(e.id).length).length;
    let excess = cy.nodes().filter((n) => !n.data("chip")).length + incoming - NODE_CAP;
    if (excess > 0) {
      const victims = cy
        .nodes()
        .filter((n) => !n.data("chip") && n.id() !== state.anchor && n.degree(false) <= 1)
        .sort((a, b) => a.data("degree") - b.data("degree"));
      for (let i = 0; i < victims.length && excess > 0; i++, excess--) cy.remove(victims[i]);
    }

    for (const ent of body.entities) {
      if (cy.getElementById(ent.id).length) continue;
      cy.add({ data: { id: ent.id, label: ent.name, type: ent.type, size: 26, degree: ent.degree || 0 } });
    }
    for (const rel of body.relations) {
      if (cy.getElementById(rel.id).length) continue;
      if (!cy.getElementById(rel.source).length || !cy.getElementById(rel.target).length) continue;
      cy.add({ data: { id: rel.id, source: rel.source, target: rel.target, label: rel.type || "", width: 1.5 } });
    }
    const remaining = (body.total_of_type ?? 0) - (state.shown.get(key) || 0);
    if (remaining > 0) {
      chipNode.data("label", `+${remaining} ${type}`);
    } else {
      cy.remove(chipNode);
    }
    cy.layout({ name: "concentric", padding: 40, concentric: (n) => (n.id() === state.anchor ? 2 : 1), levelWidth: () => 1, minNodeSpacing: 24 }).run();
  }

  function renderEgoDetail(ent) {
    if (!detailHost || !ent) return;
    clearElement(detailHost);
    detailHost.appendChild(el("h3", null, "Entity"));
    for (const [label, value] of [["Name", ent.name], ["Type", ent.type], ["Degree", ent.degree], ["ID", ent.id]]) {
      const div = el("div", "detail-field");
      div.appendChild(el("div", "detail-label", label));
      div.appendChild(el("div", "detail-value", String(value)));
      detailHost.appendChild(div);
    }
    detailHost.appendChild(el("p", "placeholder", "Tap a node to re-anchor. Tap a dashed chip to load more neighbors."));
  }

  function onTap(node) {
    if (node.data("chip")) {
      pageInChip(node);
      return;
    }
    if (state.level === "overview") {
      showEntityList(node.data("type"));
      return;
    }
    if (node.id() === state.anchor) {
      renderEgoDetail({ id: node.id(), name: node.data("label"), type: node.data("type"), degree: node.data("degree") });
      return;
    }
    showEgo(node.id());
    if (opts.onEntitySelect) opts.onEntitySelect(node.id());
  }

  /* ---------------- chrome ---------------- */

  function renderCrumbs() {
    if (!crumbHost) return;
    clearElement(crumbHost);
    const overviewCrumb = el("button", "lv-chip" + (state.level === "overview" ? " active" : ""), "overview");
    overviewCrumb.type = "button";
    overviewCrumb.addEventListener("click", showOverview);
    crumbHost.appendChild(overviewCrumb);
    for (const [i, id] of state.trail.entries()) {
      const c = el("button", "lv-chip", labelFor(id));
      c.type = "button";
      c.addEventListener("click", () => {
        state.trail = state.trail.slice(0, i);
        showEgo(id, false);
      });
      crumbHost.appendChild(c);
    }
    if (state.level === "ego" && state.anchor) {
      crumbHost.appendChild(el("span", "lv-facet-label", labelFor(state.anchor)));
    }
  }

  function labelFor(id) {
    const n = cy && cy.getElementById(id);
    return n && n.length ? n.data("label") : id.slice(0, 10) + "…";
  }

  function renderLegend() {
    if (!legendHost) return;
    clearElement(legendHost);
    const types = state.summary ? state.summary.groups.map((g) => g.type) : Object.keys(ENTITY_COLORS);
    for (const type of types) {
      const item = el("span", "dt-legend-item");
      const swatch = el("span", "dt-swatch");
      swatch.style.background = ENTITY_COLORS[type] || "#6b7280";
      item.appendChild(swatch);
      item.appendChild(el("span", null, type));
      legendHost.appendChild(item);
    }
  }

  /* ---------------- toolbar + theme ---------------- */

  const btns = {
    "graph-zoom-in": () => cy && cy.animate({ zoom: cy.zoom() * 1.3 }, { duration: 200 }),
    "graph-zoom-out": () => cy && cy.animate({ zoom: cy.zoom() * 0.7 }, { duration: 200 }),
    "graph-fit": () => cy && cy.animate({ fit: { padding: 40 } }, { duration: 300 }),
    "graph-reset": showOverview,
  };
  for (const [id, fn] of Object.entries(btns)) {
    const b = document.getElementById(id);
    if (b) b.onclick = fn; // onclick assignment replaces any legacy handler
  }
  window.__twiningGraphThemeChanged = () => cy && cy.style(cyStyles());

  showOverview();

  return {
    refresh: () => {
      if (state.level === "overview") showOverview();
      else if (cy) cy.resize();
    },
    focus: (entityId) => showEgo(entityId),
    destroy: () => {
      if (cy) cy.destroy();
      delete window.__twiningGraphThemeChanged;
    },
  };
}
