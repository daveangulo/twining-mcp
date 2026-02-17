# Phase 10: Visualizations and Polish - Research

**Researched:** 2026-02-17
**Domain:** Interactive timeline/graph visualization with dark mode theming on existing vanilla JS dashboard
**Confidence:** HIGH

## Summary

Phase 10 adds three visual capabilities to the existing Twining dashboard: a chronological decision timeline (VIZ-01/02/06), an interactive force-directed knowledge graph visualization (VIZ-03/04/05), and a dark mode theme (VIZ-07). The dashboard already has all the infrastructure needed -- tabs, API endpoints returning decisions and graph data, detail panels, and a polling lifecycle. This phase adds two visualization library integrations and a CSS theme toggle.

The prior decision (01KHN6335P4AVW0ADGVXE30V84) locks the stack: **cytoscape.js** for graph visualization and **vis-timeline** for the chronological timeline. Both are mature, zero-dependency (in their standalone builds), framework-agnostic libraries that work with plain `<script>` tags. Since the dashboard serves all assets locally from `src/dashboard/public/` (no CDN -- critical for offline/firewall use), both library files must be vendored into the public directory.

The main architectural challenge is deciding how to integrate the two new visualization tabs with the existing tab/detail-panel system. The timeline replaces the decisions table view with a visual representation while reusing the existing detail panel for click-to-inspect. The graph visualization replaces the graph table with an interactive canvas. Both visualizations need a "table fallback" toggle or can simply augment the existing tabs with a visual mode toggle button, since the table views already exist and work well for some workflows. The recommended approach is to add the visualizations as new subtabs or view-mode toggles within the existing Decisions and Graph tabs.

**Primary recommendation:** Vendor cytoscape.js (~109KB gzipped) and vis-timeline standalone (~186KB gzipped) as minified JS/CSS files in `src/dashboard/public/vendor/`. Add timeline visualization to the Decisions tab and graph visualization to the Graph tab as alternative view modes. Implement dark mode via CSS custom properties with `data-theme` attribute toggle and localStorage persistence.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| VIZ-01 | User can view decisions on a chronological timeline showing lifecycle events | vis-timeline with DataSet items; each decision becomes a timeline item positioned at its timestamp; lifecycle events (created, superseded, overridden, reconsidered) mapped from decision status + blackboard cross-posts |
| VIZ-02 | User can click timeline items to see full decision details | vis-timeline `select` event triggers `fetchDecisionDetail()` to populate existing detail panel; reuses all existing detail rendering code |
| VIZ-03 | User can view knowledge graph as interactive force-directed visualization | cytoscape.js with `cose` layout; entities become nodes, relations become edges; graph data already available from `/api/graph` |
| VIZ-04 | User can zoom, pan, and click nodes in graph to expand neighbors | cytoscape.js built-in zoom/pan; tap event on nodes fetches neighbors and dynamically adds them via `cy.add()`; may need new API endpoint `/api/graph/neighbors/:id` |
| VIZ-05 | Graph nodes are color-coded by entity type | cytoscape.js data-driven styles: `selector: 'node[type="class"]'` with distinct background-color per entity type (8 types: module, function, class, file, concept, pattern, dependency, api_endpoint) |
| VIZ-06 | Decisions are color-coded by confidence level (high/medium/low/provisional) | vis-timeline item `className` property mapped from decision confidence/status; CSS classes `.vis-item.high`, `.vis-item.medium`, `.vis-item.low`, `.vis-item.provisional` with existing badge color scheme |
| VIZ-07 | Dashboard supports dark mode theme | CSS custom properties with `[data-theme="dark"]` selector; toggle button in header; localStorage persistence; system preference detection via `prefers-color-scheme`; cytoscape.js style refresh on theme change |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| cytoscape.js | 3.33.1 | Force-directed graph visualization | Prior decision; 109KB gzipped; built-in cose layout, data-driven styling, tap events, zoom/pan; no dependencies |
| vis-timeline (standalone) | 7.7.3 | Chronological decision timeline | Prior decision; standalone UMD build bundles vis-data + moment.js; groups, item types, select events, custom styling |
| CSS Custom Properties | (built-in) | Dark mode theming | Already used for `--bg`, `--text`, `--card-bg` etc in existing `style.css`; just add `[data-theme="dark"]` overrides |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| localStorage | (built-in) | Persist dark mode preference | Save/load theme choice across sessions |
| matchMedia | (built-in) | Detect system color scheme preference | Initial theme when no localStorage value set |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| cytoscape.js `cose` layout | cytoscape.js `fcose` extension | fcose gives better results but requires loading additional ~40KB extension; cose is built-in and sufficient for typical Twining graphs (<200 nodes) |
| vis-timeline 7.7.3 | vis-timeline 8.3.1 (CDNJS latest) | v8.x restructured to hybrid ESM+CJS; standalone UMD build may have changed structure; v7.7.3 is battle-tested for UMD standalone; recommend starting with v7.7.3 and testing v8.x if needed |
| Vendored JS files | CDN script tags | Dashboard is a local dev tool that must work offline/behind firewalls; CDN would break airgapped environments |
| cytoscape-expand-collapse extension | Manual node expansion via cy.add() | Extension is designed for compound (parent-child) graphs; Twining's graph is flat with relations; manual expansion (fetch neighbors, add nodes) is simpler and requires no extra dependency |
| Separate timeline/graph tabs | View-mode toggles within existing Decisions/Graph tabs | Separate tabs duplicate navigation; toggle within existing tab reuses detail panel and keeps related data together |

**Installation:**
```bash
# No npm install needed -- vendor files are downloaded and committed to src/dashboard/public/vendor/
# Download commands:
mkdir -p src/dashboard/public/vendor
curl -o src/dashboard/public/vendor/cytoscape.min.js "https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.33.1/cytoscape.umd.min.js"
curl -o src/dashboard/public/vendor/vis-timeline-graph2d.min.js "https://unpkg.com/vis-timeline@7.7.3/standalone/umd/vis-timeline-graph2d.min.js"
curl -o src/dashboard/public/vendor/vis-timeline-graph2d.min.css "https://unpkg.com/vis-timeline@7.7.3/styles/vis-timeline-graph2d.min.css"
```

## Architecture Patterns

### Recommended Project Structure
```
src/dashboard/public/
  vendor/
    cytoscape.min.js              # ~500KB uncompressed, ~109KB gzipped
    vis-timeline-graph2d.min.js   # ~600KB uncompressed, ~186KB gzipped
    vis-timeline-graph2d.min.css  # Timeline styles
  index.html                      # MODIFIED: add script tags for vendor libs, theme toggle button, visualization containers
  style.css                       # MODIFIED: add dark mode vars, graph/timeline container styles, color-coding classes
  app.js                          # MODIFIED: add timeline/graph initialization, view-mode toggles, dark mode logic
```

### Pattern 1: View-Mode Toggle (Table vs Visual)
**What:** Add a toggle button within the existing Decisions and Graph tabs that switches between the current table view and the new visualization view. Both share the same detail panel.
**When to use:** VIZ-01, VIZ-03 (the two main visualization containers)
**Example:**
```html
<!-- Inside the existing #tab-decisions -->
<div class="view-toggle">
  <button class="view-btn active" data-view="table">Table</button>
  <button class="view-btn" data-view="timeline">Timeline</button>
</div>
<div class="view-table" id="decisions-table-view">
  <!-- existing table markup, unchanged -->
</div>
<div class="view-visual" id="decisions-timeline-view" style="display:none">
  <div id="timeline-container" style="height: 400px;"></div>
</div>
<!-- detail panel stays shared -->
```

```javascript
// Toggle handler
function toggleView(tabName, viewName) {
  var tableView = document.getElementById(tabName + '-table-view');
  var visualView = document.getElementById(tabName + '-timeline-view') ||
                   document.getElementById(tabName + '-graph-view');
  if (viewName === 'table') {
    tableView.style.display = 'block';
    visualView.style.display = 'none';
  } else {
    tableView.style.display = 'none';
    visualView.style.display = 'block';
    // Initialize/refresh visualization
    if (tabName === 'decisions') initTimeline();
    if (tabName === 'graph') initGraph();
  }
}
```

### Pattern 2: Cytoscape.js Graph Initialization with Data-Driven Styling
**What:** Initialize cytoscape.js from the existing `/api/graph` response data, mapping entities to nodes and relations to edges with type-based color coding.
**When to use:** VIZ-03, VIZ-04, VIZ-05
**Example:**
```javascript
// Source: https://js.cytoscape.org/ (verified HIGH confidence)
var ENTITY_COLORS = {
  module: '#3b82f6',       // blue
  function: '#8b5cf6',     // violet
  class: '#06b6d4',        // cyan
  file: '#6b7280',         // gray
  concept: '#f59e0b',      // amber
  pattern: '#10b981',      // emerald
  dependency: '#ef4444',   // red
  api_endpoint: '#ec4899'  // pink
};

function initGraph() {
  var elements = [];

  // Map entities to nodes
  state.graph.data.forEach(function(entity) {
    elements.push({
      data: {
        id: entity.id,
        label: entity.name,
        type: entity.type
      }
    });
  });

  // Map relations to edges
  state.graph.relations.forEach(function(rel) {
    elements.push({
      data: {
        id: rel.id,
        source: rel.source,
        target: rel.target,
        label: rel.type
      }
    });
  });

  var cy = cytoscape({
    container: document.getElementById('graph-canvas'),
    elements: elements,
    layout: { name: 'cose', animate: true, animationDuration: 500 },
    style: buildGraphStyles()  // Function returns styles based on current theme
  });

  cy.on('tap', 'node', function(evt) {
    var nodeId = evt.target.id();
    var entity = state.graph.data.find(function(e) { return e.id === nodeId; });
    if (entity) {
      state.graph.selectedId = nodeId;
      renderGraphDetail(entity);
    }
  });
}

function buildGraphStyles() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return [
    { selector: 'node', style: {
      'label': 'data(label)',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'font-size': '10px',
      'color': isDark ? '#e2e8f0' : '#1a1a2e',
      'width': 30, 'height': 30
    }},
    { selector: 'node[type="module"]', style: { 'background-color': ENTITY_COLORS.module }},
    { selector: 'node[type="function"]', style: { 'background-color': ENTITY_COLORS['function'] }},
    { selector: 'node[type="class"]', style: { 'background-color': ENTITY_COLORS['class'] }},
    { selector: 'node[type="file"]', style: { 'background-color': ENTITY_COLORS.file }},
    { selector: 'node[type="concept"]', style: { 'background-color': ENTITY_COLORS.concept }},
    { selector: 'node[type="pattern"]', style: { 'background-color': ENTITY_COLORS.pattern }},
    { selector: 'node[type="dependency"]', style: { 'background-color': ENTITY_COLORS.dependency }},
    { selector: 'node[type="api_endpoint"]', style: { 'background-color': ENTITY_COLORS.api_endpoint }},
    { selector: 'edge', style: {
      'width': 2,
      'line-color': isDark ? '#475569' : '#cbd5e1',
      'target-arrow-color': isDark ? '#475569' : '#cbd5e1',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'label': 'data(label)',
      'font-size': '8px',
      'color': isDark ? '#94a3b8' : '#64748b'
    }},
    { selector: 'node:selected', style: {
      'border-width': 3,
      'border-color': '#3b82f6'
    }}
  ];
}
```

### Pattern 3: vis-timeline Decision Timeline with Confidence Color-Coding
**What:** Render decisions as timeline items positioned chronologically, color-coded by confidence level, with click-to-select wired to the existing detail panel.
**When to use:** VIZ-01, VIZ-02, VIZ-06
**Example:**
```javascript
// Source: https://visjs.github.io/vis-timeline/docs/timeline/ (verified HIGH confidence)
var CONFIDENCE_CLASSES = {
  high: 'confidence-high',
  medium: 'confidence-medium',
  low: 'confidence-low'
};
var STATUS_CLASSES = {
  provisional: 'status-provisional',
  superseded: 'status-superseded',
  overridden: 'status-overridden'
};

function initTimeline() {
  var items = new vis.DataSet();

  state.decisions.data.forEach(function(d) {
    // Determine CSS class: status classes override confidence classes
    var className = CONFIDENCE_CLASSES[d.confidence] || '';
    if (d.status !== 'active') {
      className = STATUS_CLASSES[d.status] || className;
    }

    items.add({
      id: d.id,
      content: truncate(d.summary, 60),
      start: d.timestamp,
      className: className,
      title: d.summary + ' [' + d.status + ', ' + d.confidence + ' confidence]'
    });
  });

  var container = document.getElementById('timeline-container');
  var options = {
    zoomMin: 1000 * 60 * 60,           // 1 hour min zoom
    zoomMax: 1000 * 60 * 60 * 24 * 365, // 1 year max zoom
    orientation: { axis: 'top' },
    selectable: true,
    tooltip: { followMouse: true }
  };

  var timeline = new vis.Timeline(container, items, options);

  timeline.on('select', function(properties) {
    if (properties.items.length > 0) {
      var id = properties.items[0];
      state.decisions.selectedId = id;
      fetchDecisionDetail(id);
    }
  });

  // Fit to show all items
  timeline.fit();
}
```

### Pattern 4: Dark Mode with CSS Custom Properties
**What:** Toggle dark mode by setting `data-theme="dark"` on `<html>` element. All color values read from CSS custom properties that are redefined under `[data-theme="dark"]`.
**When to use:** VIZ-07
**Example:**
```css
/* Source: MDN prefers-color-scheme, CSS-Tricks dark mode guide (verified HIGH confidence) */

/* Light theme (default -- already exists in style.css as :root vars) */
:root {
  --bg: #f8f9fa;
  --text: #1a1a2e;
  --card-bg: #ffffff;
  --card-border: #e2e8f0;
  --accent: #3b82f6;
  /* ... existing vars ... */
}

/* Dark theme overrides */
[data-theme="dark"] {
  --bg: #0f172a;
  --text: #e2e8f0;
  --card-bg: #1e293b;
  --card-border: #334155;
  --accent: #60a5fa;
  --success: #4ade80;
  --error: #f87171;
  --warning: #fbbf24;
  --muted: #94a3b8;
}

/* vis-timeline dark overrides */
[data-theme="dark"] .vis-timeline {
  border-color: var(--card-border);
}
[data-theme="dark"] .vis-item {
  background-color: var(--card-bg);
  border-color: var(--card-border);
  color: var(--text);
}
[data-theme="dark"] .vis-time-axis .vis-text {
  color: var(--muted);
}
```

```javascript
// Theme toggle logic
function initTheme() {
  var saved = localStorage.getItem('twining-theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('twining-theme', next);

  // Refresh cytoscape styles if graph is initialized
  if (window.cy) {
    window.cy.style(buildGraphStyles());
  }
}
```

### Anti-Patterns to Avoid
- **Loading vendor libs from CDN:** Dashboard is a local dev tool; must work offline. Always serve from `public/vendor/`.
- **Using innerHTML for timeline item templates:** XSS risk; use vis-timeline's `template` function with textContent or the default text rendering.
- **Recreating cytoscape/timeline instances on every poll:** Create once, update data incrementally. Use `cy.add()`/`cy.remove()` and `items.update()` for DataSet updates.
- **Hard-coding colors instead of CSS variables:** Makes dark mode impossible. Always reference `var(--name)` in CSS; for cytoscape.js (which uses its own style system), read computed CSS vars in the style builder function.
- **Blocking initial render on visualization libraries:** Load vendor scripts with `defer`; initialize visualizations only when their tab/view-mode is activated (lazy init).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Force-directed graph layout | Custom force simulation algorithm | cytoscape.js `cose` layout | Graph layout is a solved problem with decades of research; cose handles node overlap, edge crossing minimization, animation |
| Timeline rendering with zoom/pan | Custom canvas-based timeline | vis-timeline | Time axis formatting, zoom levels, item positioning, drag interactions are deceptively complex |
| Color scheme toggling | Manual style attribute changes on every element | CSS custom properties + `data-theme` attribute | One attribute change propagates to all elements via CSS cascade; no JavaScript per-element manipulation needed |
| Graph node click-to-expand | Custom BFS traversal from API data | cytoscape.js built-in traversal + `/api/graph` | cy.add() handles incremental graph updates cleanly |

**Key insight:** Visualization libraries encapsulate layout algorithms, interaction handlers, and rendering pipelines that would take thousands of lines to hand-roll. The vendored libraries are ~295KB gzipped total -- well worth the cost for a local dev tool.

## Common Pitfalls

### Pitfall 1: Cytoscape Container Must Have Explicit Dimensions
**What goes wrong:** Graph renders as zero-height invisible element.
**Why it happens:** Cytoscape.js reads container dimensions at init time. If the container has no explicit height (e.g., via CSS or inline style), the canvas is 0px tall.
**How to avoid:** Set `min-height: 400px` on the `#graph-canvas` container. Also ensure the container is visible (not `display:none`) when `cytoscape()` is called -- if the graph tab is hidden, defer initialization until the tab is shown.
**Warning signs:** Graph tab shows blank white space; console has no errors.

### Pitfall 2: vis-timeline Container Must Be Visible at Init
**What goes wrong:** Timeline renders with wrong dimensions or items are not positioned correctly.
**Why it happens:** vis-timeline calculates item positions based on container width at construction time. If container is `display:none`, width is 0.
**How to avoid:** Initialize timeline only when the Decisions tab is visible AND the timeline view mode is active. Call `timeline.redraw()` or `timeline.fit()` after making the container visible.
**Warning signs:** Timeline items appear stacked at left edge; zoom/pan doesn't work correctly.

### Pitfall 3: Memory Leak from Recreating Visualizations
**What goes wrong:** Browser memory grows on every tab switch or data refresh.
**Why it happens:** Creating new `cytoscape()` or `vis.Timeline()` instances without destroying the old one leaks event listeners and canvas resources.
**How to avoid:** Create instances once, store in global state. On data refresh, update the data (not the instance). On tab switch, call `cy.resize()` / `timeline.redraw()`. Provide explicit `destroy()` calls only if the dashboard page is unloaded.
**Warning signs:** Gradual browser slowdown; multiple canvas elements in DOM inspector.

### Pitfall 4: vis-timeline Standalone Bundle Includes moment.js
**What goes wrong:** Unexpected bundle size increase; potential conflicts if moment.js is loaded separately.
**Why it happens:** The standalone build intentionally bundles moment.js and vis-data. This is by design for zero-config usage.
**How to avoid:** Use only the standalone build; never load moment.js separately. The bundled moment is self-contained and doesn't pollute the global scope beyond `vis.DataSet` and `vis.Timeline`.
**Warning signs:** Console warnings about duplicate moment.js definitions.

### Pitfall 5: Dark Mode Style Sync with Cytoscape
**What goes wrong:** Graph stays light-themed after toggling dark mode.
**Why it happens:** Cytoscape.js uses its own styling system (not CSS). Changing CSS custom properties has no effect on cytoscape styles.
**How to avoid:** After toggling theme, call `cy.style(buildGraphStyles())` where `buildGraphStyles()` reads the current theme and returns appropriate colors. For vis-timeline, CSS overrides with `[data-theme="dark"]` selectors work because vis-timeline renders DOM elements (not canvas).
**Warning signs:** Graph visualization colors don't change when rest of dashboard toggles dark/light.

### Pitfall 6: Decision Lifecycle Events Not Tracked Separately
**What goes wrong:** VIZ-01 says "showing lifecycle events" but decisions don't have an event history field.
**Why it happens:** A decision's status changes (active -> provisional -> overridden) are stored as current state, not as a log. The only event history is in blackboard cross-posts (entry_type: "decision" with "Override:" or "Reconsider:" prefixes).
**How to avoid:** For VIZ-01, use the decision's timestamp as the creation event. For lifecycle events, scan blackboard entries that reference the decision ID (via `relates_to` or by matching the decision ID in the entry summary/detail). This gives a reasonable approximation of lifecycle events without schema changes. Alternatively, show decisions as simple items (not ranges) positioned at creation time, and use tooltips or the detail panel to show current status.
**Warning signs:** Empty timeline because only "lifecycle events" are expected but none exist as separate records.

## Code Examples

Verified patterns from official sources:

### Cytoscape.js: Node Expansion on Click (VIZ-04)
```javascript
// Source: https://js.cytoscape.org/ — cy.add() and tap event
cy.on('tap', 'node', function(evt) {
  var nodeId = evt.target.id();

  // Check if already expanded (track in state)
  if (state.graph.expandedNodes && state.graph.expandedNodes[nodeId]) return;

  // Fetch neighbors from API
  fetch('/api/graph/neighbors/' + encodeURIComponent(nodeId))
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var newElements = [];

      // Add neighbor nodes (skip duplicates)
      (data.entities || []).forEach(function(entity) {
        if (!cy.getElementById(entity.id).length) {
          newElements.push({
            data: { id: entity.id, label: entity.name, type: entity.type }
          });
        }
      });

      // Add connecting edges
      (data.relations || []).forEach(function(rel) {
        if (!cy.getElementById(rel.id).length) {
          newElements.push({
            data: { id: rel.id, source: rel.source, target: rel.target, label: rel.type }
          });
        }
      });

      if (newElements.length > 0) {
        cy.add(newElements);
        // Re-run layout on new elements only
        cy.layout({ name: 'cose', animate: true, fit: false }).run();
      }

      // Track expansion
      if (!state.graph.expandedNodes) state.graph.expandedNodes = {};
      state.graph.expandedNodes[nodeId] = true;
    });
});
```

### vis-timeline: Confidence + Status Color-Coding (VIZ-06)
```css
/* Confidence color-coding -- reuses existing badge color scheme */
.vis-item.confidence-high {
  background-color: #dcfce7;
  border-color: #166534;
  color: #166534;
}
.vis-item.confidence-medium {
  background-color: #fef3c7;
  border-color: #92400e;
  color: #92400e;
}
.vis-item.confidence-low {
  background-color: #fecaca;
  border-color: #991b1b;
  color: #991b1b;
}

/* Status overrides for non-active decisions */
.vis-item.status-provisional {
  background-color: #fef3c7;
  border-color: #d97706;
  border-style: dashed;
}
.vis-item.status-superseded {
  background-color: #f1f5f9;
  border-color: #475569;
  opacity: 0.6;
  text-decoration: line-through;
}
.vis-item.status-overridden {
  background-color: #fecaca;
  border-color: #991b1b;
  opacity: 0.6;
  text-decoration: line-through;
}

/* Dark mode variants */
[data-theme="dark"] .vis-item.confidence-high {
  background-color: #064e3b;
  border-color: #4ade80;
  color: #a7f3d0;
}
[data-theme="dark"] .vis-item.confidence-medium {
  background-color: #451a03;
  border-color: #fbbf24;
  color: #fde68a;
}
[data-theme="dark"] .vis-item.confidence-low {
  background-color: #450a0a;
  border-color: #f87171;
  color: #fecaca;
}
```

### Dark Mode Toggle Button (VIZ-07)
```html
<!-- In header, next to connection status -->
<button id="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">
  <span id="theme-icon">&#9789;</span>  <!-- Moon symbol -->
</button>
```

```javascript
// Initialize on DOMContentLoaded
function initTheme() {
  var saved = localStorage.getItem('twining-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
  // Listen for OS-level changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      if (!localStorage.getItem('twining-theme')) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '\u2600' : '\u263D';  // Sun / Moon
}

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'light';
  var next = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  localStorage.setItem('twining-theme', next);
  // Refresh cytoscape styles
  if (window.cyInstance) {
    window.cyInstance.style(buildGraphStyles());
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| vis-timeline v7.x UMD only | vis-timeline v8.x hybrid ESM+CJS | 2024 (v8.0.0) | Standalone UMD still works; v7.7.3 is safer for script-tag loading |
| cytoscape.js 3.x without types | cytoscape.js 3.33.1 with full TS support | 2025 | No impact for vanilla JS usage; types available if needed later |
| CSS dark mode via class toggle | CSS `[data-theme]` + `:has()` selector | 2024 | `data-theme` attribute is cleaner than class toggle; `:has()` not needed for our use case |
| `prefers-color-scheme` only | User toggle + system preference fallback | 2024 (best practice) | User choice persisted in localStorage; system preference as initial default only |

**Deprecated/outdated:**
- vis-timeline's `moment.js` usage: moment.js is in maintenance mode; but since we use the standalone bundle, this is internal to vis-timeline and not our concern.
- cytoscape.js `cose-bilkent` extension: Superseded by `fcose` extension for better force-directed layouts; but built-in `cose` is sufficient for our graph sizes.

## API Considerations

### Existing Endpoints (Sufficient)
- `GET /api/decisions` -- Returns all decisions with index data (timestamp, domain, scope, summary, status, confidence). Sufficient for timeline items.
- `GET /api/decisions/:id` -- Returns full decision detail. Already used by detail panel on click.
- `GET /api/graph` -- Returns all entities and relations. Sufficient for initial graph render.

### Potentially Needed New Endpoint
- `GET /api/graph/neighbors/:id` -- Returns entities connected to a specific entity (1-hop neighbors). Currently the client has all entities from `/api/graph` and can filter locally. For small graphs (<200 entities), client-side filtering is sufficient. Only add this endpoint if graphs grow large enough that loading all entities is too slow.

**Recommendation:** Start without the neighbors endpoint. The existing `/api/graph` returns all entities and relations; the client can compute neighbors locally by filtering `state.graph.relations` for source/target matching the clicked node. Add the API endpoint later if performance requires it.

## Open Questions

1. **vis-timeline version: 7.7.3 vs 8.3.1?**
   - What we know: v8.x restructured to hybrid ESM+CJS. The standalone UMD build path may have changed. v7.7.3 is well-documented for standalone UMD usage.
   - What's unclear: Whether the v8.x standalone UMD build works identically when loaded via `<script>` tag.
   - Recommendation: Start with v7.7.3 (well-tested standalone UMD). If v7.7.3 has issues, try v8.3.1. LOW risk either way -- vis-timeline's API is stable across major versions.

2. **Graph visualization: replace Graph tab table entirely or toggle?**
   - What we know: Table view is useful for searching/sorting entities by name/type. Visual view is better for understanding relationships.
   - What's unclear: Whether users need both views or would be satisfied with just the visual view.
   - Recommendation: View-mode toggle (Table | Graph). Default to visual mode, allow switching to table. This preserves all existing functionality.

3. **Should vendor files be committed to git or downloaded at build time?**
   - What we know: The project has no build step for the frontend. `postbuild` just copies `src/dashboard/public/` to `dist/dashboard/public/`. Committing vendor files means they're always available; downloading means smaller repo.
   - What's unclear: Project preference on vendored binaries in git.
   - Recommendation: Commit vendor files to git. They're ~1MB total, change rarely (only on version bumps), and ensure the dashboard works immediately after clone without any download step. Add a comment in the file headers noting the version and source URL.

## Sources

### Primary (HIGH confidence)
- [Cytoscape.js official site](https://js.cytoscape.org/) - Version 3.33.1, layout names, styling, events, dynamic elements
- [vis-timeline documentation](https://visjs.github.io/vis-timeline/docs/timeline/) - Groups, item types, events, methods, templates, options
- [vis-timeline standalone build example](https://visjs.github.io/vis-timeline/examples/timeline/standalone-build.html) - UMD loading pattern, DataSet usage
- [CDNJS cytoscape](https://cdnjs.com/libraries/cytoscape) - File URLs for v3.33.1
- [CDNJS vis-timeline](https://cdnjs.com/libraries/vis-timeline) - File URLs for v8.3.1 (with v7.7.3 available via unpkg)

### Secondary (MEDIUM confidence)
- [CSS-Tricks dark mode guide](https://css-tricks.com/a-complete-guide-to-dark-mode-on-the-web/) - CSS custom properties + data-theme pattern
- [MDN prefers-color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme) - System preference detection
- [web.dev prefers-color-scheme](https://web.dev/articles/prefers-color-scheme) - localStorage persistence pattern
- [vis-timeline v8.0.0 release](https://github.com/visjs/vis-timeline/releases/tag/v8.0.0) - Breaking changes: hybrid ESM+CJS rework
- [cytoscape.js dark mode discussion](https://github.com/cytoscape/cytoscape.js/discussions/3311) - cy.style() refresh pattern for theme changes

### Tertiary (LOW confidence)
- cytoscape.js gzipped size ~109KB - Referenced in prior decision rationale; confirmed approximately by .size-snapshot.json on GitHub
- vis-timeline standalone gzipped size ~186KB - Referenced in prior decision rationale; not independently verified for v7.7.3 specifically

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Libraries locked by prior decision; CDN/docs verified
- Architecture: HIGH - Existing dashboard patterns well-established; view-mode toggle follows prior tab pattern
- Pitfalls: HIGH - Container dimension issues, memory leaks, and theme sync are well-documented problems with known solutions
- Timeline lifecycle events: MEDIUM - Decision model lacks explicit event history; blackboard cross-post scanning is a reasonable workaround but may not capture all lifecycle transitions

**Research date:** 2026-02-17
**Valid until:** 2026-04-17 (stable libraries, unlikely to change significantly)
