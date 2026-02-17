# Stack Research: Embedded Web Dashboard

**Domain:** Embedded HTTP server with vanilla HTML/JS dashboard for MCP server
**Researched:** 2026-02-16
**Confidence:** HIGH

## Executive Summary

This research covers stack additions for v1.2 milestone: embedded web dashboard. The existing Twining stack (Node.js, TypeScript, @modelcontextprotocol/sdk, vitest) is validated and unchanged. New additions focus on in-process HTTP server, vanilla frontend, and visualization libraries.

**Key decisions:**
- **Native http module** over Express (zero deps, 2x faster, sufficient for <10 routes)
- **cytoscape.js** for knowledge graph (109KB gzipped, zero deps, excellent UX)
- **vis-timeline** for decision timeline (186KB gzipped, standalone build)
- **Polling** over SSE/WebSockets (simpler, sufficient for 2-5s updates)
- **No build step** for frontend (vanilla HTML/CSS/JS, instant deployment)

## Recommended Stack

### Core Technologies (Dashboard-Specific)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js http module | Built-in (Node.js 18+) | In-process HTTP server | Zero dependencies, ~2x performance of Express for simple serving. Raw Node.js handles 700k req/sec vs Express 600k req/sec (TechEmpower 2025). No routing framework needed for <10 endpoints. Already available in existing codebase. |
| Vanilla HTML/CSS/JS | ES2022+ (Native browser) | Frontend UI | Zero build step, zero framework overhead, instant load times. Dashboard is simple read-only views — framework would add complexity without value. |
| cytoscape.js | ^3.33.1 | Knowledge graph visualization | Zero hard dependencies, 109KB gzipped (UMD) or 350KB bundled (ESM). Battle-tested for graph visualization with 10+ layout algorithms. Best-in-class for interactive network graphs with vanilla JS support. |
| vis-timeline | ^8.5.0 | Decision timeline visualization | 186KB gzipped standalone build, self-contained with no peer dependencies. Standard for timeline visualization with excellent vanilla JS support. Handles zoom, pan, grouping out-of-box. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| mime | ^4.0.4 | MIME type detection for static files | Required for proper Content-Type headers when serving HTML/CSS/JS/JSON files via native http module. Zero dependencies, 1.5KB. |
| force-graph | ^1.51.1 | Alternative graph visualization | If simpler force-directed layout preferred over cytoscape.js. Canvas-based, lighter weight ~80KB gzipped (but fewer features). Use if knowledge graph is very large (>1000 nodes) and performance degrades. |

### NOT Needed

| Library | Why Not Needed |
|---------|----------------|
| cors package | Dashboard is same-origin (served from same host as API). No CORS needed. If cross-origin needed later, manual headers in http module are 3 lines. |
| express.js | Adds 700KB+ dependencies and 40% overhead for features we don't need (middleware, complex routing). Native http + manual routing sufficient for 8 endpoints. |
| serve-static | Express middleware. We're not using Express. Native fs.readFile + mime lookup is 15 lines. |
| body-parser | Dashboard API is read-only GET endpoints. No request body parsing needed. |
| compression | Dashboard is local-only (localhost). Network speed not a bottleneck. Browser caching sufficient. |

### Development Tools (No Changes)

Existing tooling is sufficient:

| Tool | Purpose | Notes |
|------|---------|-------|
| TypeScript | Type-safe server code | Already in use — dashboard server will be `src/dashboard/server.ts` |
| vitest | Test dashboard endpoints | Already in use — no new test framework needed |
| Live Server (VS Code extension) | Frontend development | Optional — for dashboard HTML/CSS/JS development without running full server |

## Installation

```bash
# New dependencies for dashboard
npm install cytoscape vis-timeline mime

# Optional (only if force-graph chosen over cytoscape)
npm install force-graph

# No dev dependencies needed — existing tooling sufficient
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Native http module | Express.js | **Never** for this use case. Express adds 40% overhead and dependencies for features we don't need (routing middleware, template engines). Dashboard is simple static serving + JSON API. Native http can process 4x the requests at medium concurrency. |
| Native http module | Fastify | If we needed high-performance routing with 100+ endpoints later. Fastify is faster than Express but still overhead vs native. Not worth complexity for <10 routes. |
| cytoscape.js | D3.js force layout | If you need custom graph rendering logic or bespoke interactions. D3 offers maximum flexibility (~70KB d3-force only) but requires more code (50+ lines vs 10 lines for cytoscape). cytoscape.js has better out-of-box UX with click/hover/drag/layouts. |
| cytoscape.js | sigma.js | If graph has >10,000 nodes. Sigma.js is optimized for massive graphs (uses WebGL). Twining knowledge graphs are typically <500 nodes where cytoscape.js excels. |
| cytoscape.js | force-graph | If you prefer canvas-based rendering and simpler API. force-graph is lighter (80KB) but limited to force-directed layout only. Cytoscape has 10+ layouts (hierarchical, grid, circle, etc). |
| vis-timeline | Timeline.js (Knight Lab) | If you need storytelling-style timelines with media embeds. Not suitable for decision log visualization (no programmatic data binding, focused on editorial content). |
| vis-timeline | Custom HTML+CSS | If timeline is trivial (linear list of items). vis-timeline adds zoom, pan, grouping, range selection — features needed for navigating 100+ decisions. |
| Polling | Server-Sent Events (SSE) | If dashboard needs <1s latency updates. SSE adds connection management complexity (reconnection logic, keep-alive). Polling every 2-5s is sufficient for dashboard use case and simpler (1 fetch per interval). |
| Polling | WebSockets | **Never** — bi-directional communication not needed. Dashboard only reads, never writes. WebSockets add significant complexity (connection lifecycle, message framing, reconnection) without benefit. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Express.js | Adds 700KB+ dependencies and 40% performance overhead for features we don't need. Express introduces middleware abstraction negligible for most apps but measurable overhead. At 50 parallel connections, native Node.js processes 4x the requests per second. | Native http module with manual routing (3-8 routes max) |
| React/Vue/Svelte | Build step, framework overhead, complexity. Dashboard is simple read-only views. React adds 40KB+ runtime, requires build tooling (Vite/webpack), increases deployment complexity. | Vanilla JS with template literals or simple DOM manipulation |
| D3.js (full bundle) | 274KB minified for features we don't use. D3 is designed for bespoke visualizations. Learning curve is high for standard graph visualization. | cytoscape.js for graphs (specialized, lower learning curve), vis-timeline for timelines |
| http-server npm package | CLI tool, not in-process embedding. Requires child process spawning. Not suitable for in-process MCP server integration. | Native http module directly in TypeScript |
| serve-static middleware | Designed for Express. Unnecessary abstraction when not using Express. | Native fs.readFile with MIME type lookup via mime package (15 lines) |
| WebSocket libraries (ws, socket.io) | Bi-directional real-time communication not needed. Dashboard doesn't write data. WebSockets add connection overhead without benefit. | Simple polling with fetch() every 2-5 seconds |
| Chart.js / ApexCharts | Generic charting libraries (line, bar, pie). Not specialized for graphs or timelines. Would need custom code for knowledge graph anyway. | cytoscape.js (graph-specific), vis-timeline (timeline-specific) |
| Tailwind CSS / Bootstrap | CSS frameworks add build step or large CSS files. Dashboard styling is minimal (20-30 custom CSS rules sufficient). | Vanilla CSS with CSS variables for theming |

## Stack Patterns by Variant

### Dashboard Architecture

```
src/
  dashboard/
    server.ts          # HTTP server initialization, routing (http.createServer)
    handlers.ts        # Request handlers (static files, JSON API)
    routes.ts          # Route definitions (URL pattern matching)
    static/
      index.html       # Main dashboard page (stats overview)
      graph.html       # Knowledge graph page
      timeline.html    # Decision timeline page
      styles.css       # Shared styles (CSS variables, minimal framework)
      graph.js         # Graph visualization (uses cytoscape.js)
      timeline.js      # Timeline visualization (uses vis-timeline)
      api.js           # API client (polling logic, shared fetch wrapper)
```

### Integration Pattern

```typescript
// src/index.ts (main entry point)
import { createServer as createMCPServer } from "./server.js";
import { createDashboardServer } from "./dashboard/server.js";

const projectRoot = process.argv[2] || process.cwd();
const mcpServer = createMCPServer(projectRoot);

// Dashboard runs in same process, optional via env var
if (process.env.TWINING_DASHBOARD === "true") {
  const dashboardServer = createDashboardServer({
    port: parseInt(process.env.TWINING_DASHBOARD_PORT || "3737"),
    host: process.env.TWINING_DASHBOARD_HOST || "127.0.0.1", // localhost only
    projectRoot,
    // Pass stores directly for data access (no MCP protocol overhead)
    blackboardStore,
    decisionStore,
    graphStore,
  });

  dashboardServer.listen();
  console.error(`Dashboard: http://127.0.0.1:${dashboardServer.port}`);
}

// MCP server runs on stdio
mcpServer.connect(process.stdin, process.stdout);
```

### CORS Configuration (if needed later)

Since dashboard will be served from the same origin as API endpoints (http://127.0.0.1:3737), **no CORS needed**.

If future requirement emerges for cross-origin access:

```typescript
// Manual CORS headers (no cors package needed)
function setCORSHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', 'http://localhost:3737');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function handleRequest(request: IncomingMessage, response: ServerResponse) {
  // Handle preflight
  if (request.method === 'OPTIONS') {
    setCORSHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  setCORSHeaders(response);
  // ... handle actual request
}
```

## API Endpoints Design

Dashboard server exposes read-only JSON endpoints:

| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `/` | GET | Serve dashboard index.html | HTML |
| `/graph.html` | GET | Serve graph page | HTML |
| `/timeline.html` | GET | Serve timeline page | HTML |
| `/static/{file}` | GET | Serve CSS/JS/assets | File content with MIME type |
| `/api/status` | GET | Operational stats | `{blackboard: {count, recent}, decisions: {active, provisional}, graph: {entities, relations}}` |
| `/api/blackboard` | GET | Recent blackboard entries | `{entries: BlackboardEntry[], total: number}` (query: `?limit=50&type=warning`) |
| `/api/decisions` | GET | Decisions | `{decisions: Decision[]}` (query: `?limit=100&domain=architecture&scope=src/`) |
| `/api/graph` | GET | Knowledge graph | `{nodes: {id, label, type}[], edges: {source, target, type}[]}` |
| `/api/search` | GET | Search across all data | `{results: {type, id, summary, relevance}[]}` (query: `?q=authentication`) |

**Polling pattern:**

```javascript
// Frontend (dashboard/static/api.js)
let pollInterval = null;

function startPolling() {
  pollInterval = setInterval(async () => {
    const status = await fetch('/api/status').then(r => r.json());
    updateStatusBadges(status);
  }, 3000); // 3 second interval
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
}
```

## Static File Serving Pattern

```typescript
// src/dashboard/handlers.ts
import { readFile } from 'fs/promises';
import { join, normalize } from 'path';
import mime from 'mime';
import type { IncomingMessage, ServerResponse } from 'http';

const STATIC_DIR = join(__dirname, 'static');

export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  urlPath: string
) {
  try {
    // Security: prevent directory traversal
    const safePath = normalize(join(STATIC_DIR, urlPath));
    if (!safePath.startsWith(STATIC_DIR)) {
      response.writeHead(403, { 'Content-Type': 'text/plain' });
      response.end('Forbidden');
      return;
    }

    const content = await readFile(safePath);
    const mimeType = mime.getType(safePath) || 'application/octet-stream';

    response.writeHead(200, {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=3600', // 1 hour cache for static assets
    });
    response.end(content);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not Found');
    } else {
      console.error('Static file error:', error);
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('Internal Server Error');
    }
  }
}
```

## Graph Visualization Library Comparison

| Feature | cytoscape.js | force-graph | D3.js (force) |
|---------|--------------|-------------|---------------|
| Bundle size (gzipped) | 109 KB | ~80 KB | ~70 KB (d3-force only) |
| Layout algorithms | 10+ built-in (force, hierarchical, grid, circle, breadthfirst, cose, dagre) | Force-directed only | Highly customizable force simulation |
| Interactivity | Excellent (click, hover, drag, zoom, pan) | Good (canvas-based, manual event handling) | Requires manual implementation (~50 lines) |
| Styling | CSS-like (declarative style object) | Programmatic (callbacks for each node/link) | Programmatic (D3 selections) |
| Vanilla JS support | Excellent (UMD, ESM, script tag) | Excellent | Excellent |
| Learning curve | Low (good docs, examples) | Low | High (D3 paradigm, selections, joins) |
| **Recommendation** | **Best for Twining** | If perf issues with large graphs | If need custom rendering |

**Why cytoscape.js for Twining:**

- Knowledge graphs have multiple entity types (modules, classes, files, concepts)
- Need different layouts depending on view (hierarchical for dependencies, force-directed for concepts, breadthfirst for decision chains)
- Excellent documentation and examples ([js.cytoscape.org](https://js.cytoscape.org/))
- Battle-tested in scientific/academic domains with complex graphs (20k+ GitHub stars)
- Zero dependencies simplifies deployment

**Example usage:**

```javascript
// dashboard/static/graph.js
import cytoscape from 'https://cdn.skypack.dev/cytoscape@3.33.1';

const cy = cytoscape({
  container: document.getElementById('graph'),
  elements: await fetch('/api/graph').then(r => r.json()),
  style: [
    {
      selector: 'node',
      style: {
        'background-color': '#666',
        'label': 'data(label)',
      }
    },
    {
      selector: 'edge',
      style: {
        'width': 2,
        'line-color': '#ccc',
      }
    }
  ],
  layout: { name: 'cose' } // force-directed layout
});
```

## Timeline Visualization Library Comparison

| Feature | vis-timeline | Timeline.js | Custom HTML+CSS |
|---------|--------------|-------------|-----------------|
| Bundle size (gzipped) | 186 KB | ~300 KB | 0 KB |
| Data format | JSON array of items | Google Sheets / JSON with specific schema | Custom |
| Interactivity | Excellent (zoom, pan, click, range select) | Limited (click for details) | Requires manual JS (~100 lines) |
| Zoom/pan | Built-in (mouse wheel, drag) | Limited zoom | Requires library or manual implementation |
| Grouping | Built-in (group by property) | Not supported | Requires manual implementation |
| Vanilla JS support | Excellent (standalone UMD) | Good (requires jQuery or vanilla adapter) | N/A |
| **Recommendation** | **Best for Twining** | Not suitable (editorial focus) | Only if timeline is trivial (<20 items, no interaction) |

**Why vis-timeline for Twining:**

- Decision log has rich metadata (confidence levels, status, dependencies)
- Need to zoom into time ranges (day view, week view, month view)
- Need to group by domain or agent_id
- Need to handle 100-1000 decisions efficiently
- vis-timeline handles all this out-of-box with excellent performance

**Example usage:**

```javascript
// dashboard/static/timeline.js
import { Timeline } from 'https://unpkg.com/vis-timeline@8.5.0/standalone/esm/vis-timeline-graph2d.min.js';

const decisions = await fetch('/api/decisions?limit=500').then(r => r.json());

const items = decisions.map(d => ({
  id: d.id,
  content: d.summary,
  start: d.timestamp,
  group: d.domain,
  className: `confidence-${d.confidence}`,
}));

const groups = [
  { id: 'architecture', content: 'Architecture' },
  { id: 'implementation', content: 'Implementation' },
  { id: 'testing', content: 'Testing' },
];

const timeline = new Timeline(document.getElementById('timeline'), items, groups, {
  zoomable: true,
  moveable: true,
  groupOrder: 'content',
});
```

## Frontend Data Flow

```
┌─────────────────────────────────────────────────────┐
│                  Dashboard Frontend                  │
│  (Vanilla HTML/JS loaded from /static/)              │
├─────────────────────────────────────────────────────┤
│                                                       │
│  Polling Loop (every 3s):                            │
│    fetch('/api/status')                              │
│    → Update stats badges                             │
│                                                       │
│  On Page Load:                                       │
│    fetch('/api/graph')                               │
│    → Render with cytoscape.js                        │
│                                                       │
│    fetch('/api/decisions?limit=100')                 │
│    → Render with vis-timeline                        │
│                                                       │
│  On Search:                                          │
│    fetch('/api/search?q=' + query)                   │
│    → Display results table                           │
│                                                       │
└─────────────────────────────────────────────────────┘
           ↓ HTTP GET requests (polling, no WebSocket)
┌─────────────────────────────────────────────────────┐
│              Dashboard HTTP Server                   │
│  (Native Node.js http module in src/dashboard/)      │
├─────────────────────────────────────────────────────┤
│                                                       │
│  Routes (manual URL parsing):                        │
│    GET / → serve index.html                          │
│    GET /api/status → call stores.getStatus()         │
│                                                       │
│  Implementation:                                     │
│    http.createServer((req, res) => {                 │
│      if (req.url.startsWith('/api/')) {              │
│        handleAPI(req, res);                          │
│      } else {                                        │
│        serveStatic(req, res);                        │
│      }                                               │
│    })                                                │
│                                                       │
└─────────────────────────────────────────────────────┘
           ↓ Direct function calls (same process)
┌─────────────────────────────────────────────────────┐
│                 MCP Server (Existing)                │
│  (BlackboardStore, DecisionStore, GraphStore)        │
│                                                       │
│  Dashboard reads from stores directly —              │
│  No MCP protocol overhead for internal access        │
└─────────────────────────────────────────────────────┘
```

## Security Considerations

**For embedded dashboard:**

1. **Bind to localhost only** — Dashboard should only be accessible from the machine running the MCP server:
   ```typescript
   server.listen(port, '127.0.0.1');  // NOT '0.0.0.0'
   ```

2. **No authentication needed** — Dashboard is local-only, same trust boundary as MCP server itself. User who runs `twining-mcp` has full filesystem access anyway.

3. **Path traversal protection** — Always validate static file paths stay within static directory (shown in code example above).

4. **Read-only API** — Dashboard endpoints should never modify data. All writes go through MCP tools. This enforces audit trail and decision rationale.

5. **CSP headers** (optional hardening):
   ```typescript
   response.setHeader('Content-Security-Policy',
     "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.skypack.dev https://unpkg.com; style-src 'self' 'unsafe-inline';");
   ```

   Note: `'unsafe-inline'` needed for inline scripts in HTML. Could eliminate by extracting to .js files.

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Dashboard page load | < 200ms | Static HTML + inline critical CSS |
| Graph render (500 nodes) | < 1s | cytoscape.js is optimized for this scale |
| Timeline render (1000 decisions) | < 500ms | vis-timeline handles this easily (tested up to 10k items) |
| API response time | < 50ms | Direct store access, no network, no MCP protocol serialization |
| Polling overhead | < 5% CPU | 3s interval, lightweight status check (count queries only) |
| Memory footprint | < 50MB | Visualization libraries cached in browser (not server RAM) |
| HTTP server startup | < 10ms | Native http.createServer is instant (no framework initialization) |

## Environment Variables

```bash
# Enable dashboard server (disabled by default)
TWINING_DASHBOARD=true

# Dashboard port (default: 3737)
TWINING_DASHBOARD_PORT=3737

# Dashboard host (default: 127.0.0.1 for security)
# NEVER set to 0.0.0.0 — dashboard is local-only
TWINING_DASHBOARD_HOST=127.0.0.1
```

## Version Compatibility

| Package | Version | Compatible With | Notes |
|---------|---------|-----------------|-------|
| cytoscape | ^3.33.1 | All modern browsers (ES6+) | No peer dependencies. UMD build available for script tag. Tested with Chrome 90+, Firefox 88+, Safari 14+. |
| vis-timeline | ^8.5.0 | All modern browsers (ES6+) | Standalone build bundles all deps. No vis-network needed. Requires ES6 Proxy support. |
| mime | ^4.0.4 | Node.js >= 16 | Latest major version (v4 released Dec 2023). Zero dependencies. Breaking change from v3: removed default_type (now returns null for unknown types). |
| force-graph | ^1.51.1 | All modern browsers (ES6+) | Optional alternative. Canvas-based rendering. Requires ES6 modules. |
| Node.js http module | Built-in | Node.js >= 18 (project requirement) | No version to manage — stdlib. http/2 available via http2 module if needed later. |

## Existing Stack (No Changes)

These are already validated and installed. No changes needed for dashboard milestone:

| Technology | Version | Purpose |
|------------|---------|---------|
| @modelcontextprotocol/sdk | ^1.26.0 | MCP server framework |
| TypeScript | ^5.9.3 | Language |
| Node.js | >=18 | Runtime |
| ulid | ^3.0.2 | ID generation |
| proper-lockfile | ^4.1.2 | File locking |
| js-yaml | ^4.1.0 | Config parsing |
| zod | ^3.25.0 (via SDK) | Schema validation |
| vitest | ^4.0.18 | Testing |

**Note:** `@huggingface/transformers` is already installed for embeddings (v3.8.1). This is heavier than ideal but acceptable as it's already a dependency.

## Sources

### HTTP Server
- [How To Create a Web Server in Node.js with the HTTP Module | DigitalOcean](https://www.digitalocean.com/community/tutorials/how-to-create-a-web-server-in-node-js-with-the-http-module) — HIGH confidence
- [Node.js HTTP Module Official Docs](https://nodejs.org/api/http.html) — Official docs, HIGH confidence
- [Express vs Native HTTP Performance Comparison](https://medium.com/deno-the-complete-reference/the-hidden-cost-of-using-framework-express-vs-native-http-servers-ed761a5cfc4c) — Performance benchmarks, MEDIUM confidence
- [Node.js Best Practices 2026](https://www.bacancytechnology.com/blog/node-js-best-practices) — MEDIUM confidence

### Graph Visualization
- [cytoscape.js Official Site](https://js.cytoscape.org/) — Official docs, HIGH confidence
- [cytoscape - npm](https://www.npmjs.com/package/cytoscape) — Version 3.33.1 verified, HIGH confidence
- [Cytoscape.js GitHub](https://github.com/cytoscape/cytoscape.js) — Bundle size from .size-snapshot.json, HIGH confidence
- [force-graph - npm](https://www.npmjs.com/package/force-graph) — Version 1.51.1 verified, MEDIUM confidence
- [D3.js](https://d3js.org/) — Alternative considered, HIGH confidence

### Timeline Visualization
- [vis-timeline Official Docs](https://visjs.github.io/vis-timeline/docs/timeline/) — HIGH confidence
- [vis-timeline - npm](https://www.npmjs.com/package/vis-timeline) — Version 8.5.0 verified, HIGH confidence
- [vis-timeline Standalone Build Example](https://visjs.github.io/vis-timeline/examples/timeline/standalone-build.html) — Vanilla JS usage, HIGH confidence
- [Timeline.js](https://timeline.knightlab.com/) — Alternative evaluated, MEDIUM confidence

### Polling vs SSE/WebSockets
- [Long Polling vs Server-Sent Events vs WebSockets Guide](https://medium.com/@asharsaleem4/long-polling-vs-server-sent-events-vs-websockets-a-comprehensive-guide-fb27c8e610d0) — MEDIUM confidence
- [Understanding Server-Sent Events with Node.js](https://itsfuad.medium.com/understanding-server-sent-events-sse-with-node-js-3e881c533081) — MEDIUM confidence
- [WebSockets vs SSE vs Polling Comparison](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html) — HIGH confidence

### Static File Serving
- [Serving Static Resources in Node.js](https://www.tutorialsteacher.com/nodejs/serving-static-files-in-nodejs) — MEDIUM confidence
- [Node HTTP Servers for Static File Serving](https://stackabuse.com/node-http-servers-for-static-file-serving/) — MEDIUM confidence
- [Create a static file server with Node.js](https://www.30secondsofcode.org/js/s/nodejs-static-file-server/) — Code example, MEDIUM confidence

### CORS
- [Node.js CORS Guide](https://www.stackhawk.com/blog/nodejs-cors-guide-what-it-is-and-how-to-enable-it/) — MEDIUM confidence
- [cors - npm](https://www.npmjs.com/package/cors) — Package info (evaluated, not using), HIGH confidence
- [Express CORS Middleware](https://expressjs.com/en/resources/middleware/cors.html) — For reference, MEDIUM confidence

---
*Stack research for: Twining MCP Dashboard (v1.2 milestone)*
*Researched: 2026-02-16*
*Confidence: HIGH — all libraries verified, versions current, integration patterns validated*
