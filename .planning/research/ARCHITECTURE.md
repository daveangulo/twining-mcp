# Architecture Research: Embedded Dashboard Integration

**Domain:** MCP Server with Embedded HTTP Dashboard
**Researched:** 2026-02-16
**Confidence:** HIGH

## Executive Summary

An embedded HTTP dashboard can coexist with stdio-based MCP transport in the same Node.js process. The dashboard runs on a separate port (localhost:24282) while the MCP server communicates via stdio. Both access the same engine layer, creating a "dual transport" architecture where agents write via MCP tools (stdio) and humans monitor via web UI (HTTP).

**Key Finding:** This is a validated pattern. Serena MCP and the MCP dual-transport architecture demonstrate that stdio and HTTP servers can run in the same process with conditional initialization based on environment/config.

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      MCP Client (Claude Desktop)                         │
│                                stdio transport                            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ JSON-RPC 2.0
                                 ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                      Twining MCP Server Process                          │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────┐                    ┌──────────────────────┐     │
│  │  StdioTransport    │                    │  HTTP Server (new)   │     │
│  │  (port: stdin/out) │                    │  (port: 24282)       │     │
│  └─────────┬──────────┘                    └──────────┬───────────┘     │
│            │                                           │                 │
│            ↓                                           ↓                 │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                    MCP Tools Layer                              │     │
│  │  blackboard-tools, decision-tools, graph-tools, etc.            │     │
│  └─────────┬──────────────────────────────────────────┬───────────┘     │
│            │                                           │                 │
│            ↓                                           ↓                 │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                    Engine Layer                                 │     │
│  │  blackboard, decisions, graph, context-assembler, etc.          │     │
│  └─────────┬──────────────────────────────────────────┬───────────┘     │
│            │                                           │                 │
│            ↓                                           ↓                 │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                    Storage Layer                                │     │
│  │  blackboard-store, decision-store, graph-store                  │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │              Dashboard API Routes (new)                         │     │
│  │  GET /api/status, /api/blackboard, /api/decisions, etc.         │     │
│  │  SSE /api/stream (Server-Sent Events for real-time updates)    │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │              Static File Serving (new)                          │     │
│  │  GET /dashboard → static/index.html                             │     │
│  │  GET /static/* → static assets (CSS, JS)                        │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ↓
                    .twining/ (file-based storage)
                    ├── blackboard.jsonl
                    ├── decisions/
                    ├── graph/
                    └── config.yml
```

### Component Responsibilities

| Component | Responsibility | Integration Type |
|-----------|----------------|------------------|
| **HTTP Server** | Serves dashboard UI and API endpoints on localhost:24282 | NEW - wraps existing engine layer |
| **Dashboard API Routes** | REST endpoints exposing engine state as JSON | NEW - reads from existing stores |
| **SSE Stream** | Server-Sent Events for real-time updates (1-second polling) | NEW - pushes state changes to browser |
| **Static File Server** | Serves bundled HTML/JS/CSS (no build step) | NEW - vanilla JS/htmx/Alpine.js |
| **StdioTransport** | Existing MCP stdio communication | UNCHANGED - runs in parallel with HTTP |
| **Engine Layer** | Existing business logic (blackboard, decisions, graph) | UNCHANGED - accessed by both stdio and HTTP |
| **Storage Layer** | File I/O to .twining/ directory | UNCHANGED - single source of truth |

## Recommended Project Structure

```
src/
├── dashboard/           # NEW - Dashboard-specific code
│   ├── server.ts        # HTTP server initialization (Express)
│   ├── routes.ts        # API route definitions
│   ├── stream.ts        # SSE implementation for real-time updates
│   └── static/          # Bundled static assets (no build step)
│       ├── index.html   # Dashboard UI (vanilla HTML)
│       ├── app.js       # Vanilla JS + htmx + Alpine.js (~29KB total)
│       ├── style.css    # Minimal CSS
│       └── lib/         # Vendored dependencies (htmx, Alpine.js)
│           ├── htmx.min.js      # 14KB
│           └── alpine.min.js    # 15KB
├── engine/              # EXISTING - Business logic
│   ├── blackboard.ts
│   ├── decisions.ts
│   ├── graph.ts
│   ├── context-assembler.ts
│   ├── archiver.ts
│   ├── exporter.ts
│   └── planning-bridge.ts
├── storage/             # EXISTING - File I/O layer
│   ├── file-store.ts
│   ├── blackboard-store.ts
│   ├── decision-store.ts
│   ├── graph-store.ts
│   └── init.ts
├── tools/               # EXISTING - MCP tool handlers
│   ├── blackboard-tools.ts
│   ├── decision-tools.ts
│   ├── context-tools.ts
│   ├── graph-tools.ts
│   ├── lifecycle-tools.ts
│   └── export-tools.ts
├── index.ts             # MODIFIED - Entry point, starts both transports
└── server.ts            # MODIFIED - MCP server + dashboard server setup
```

### Structure Rationale

- **src/dashboard/:** Isolated from core MCP functionality. Dashboard can be disabled via config without affecting stdio transport.
- **src/dashboard/static/:** All static assets are bundled (vendored), no build step required. Copy files as-is during deployment.
- **src/index.ts:** Modified to conditionally start HTTP server based on config (default: enabled on port 24282).
- **src/server.ts:** Modified to expose a `getDashboardState()` method that dashboard routes can call to read current state.

## Architectural Patterns

### Pattern 1: Dual Transport (Stdio + HTTP)

**What:** Run two transport layers in the same Node.js process—stdio for MCP communication, HTTP for dashboard access.

**When to use:** When you need a web UI alongside a stdio-based MCP server without disrupting the existing architecture.

**Trade-offs:**
- **Pro:** Single process, shared in-memory state, no IPC complexity
- **Pro:** HTTP server is optional—can be disabled for headless operation
- **Con:** HTTP server increases memory footprint (~10-20MB for Express + SSE)
- **Con:** Port conflicts possible if 24282 is in use (fallback to random port)

**Example:**
```typescript
// src/index.ts
async function main(): Promise<void> {
  const projectRoot = parseProjectRoot();
  const config = loadConfig(projectRoot);

  // Create MCP server (existing)
  const mcpServer = createServer(projectRoot);
  const stdioTransport = new StdioServerTransport();
  await mcpServer.connect(stdioTransport);

  // Conditionally start HTTP dashboard
  if (config.dashboard?.enabled !== false) {
    const dashboardPort = config.dashboard?.port || 24282;
    await startDashboardServer(mcpServer, projectRoot, dashboardPort);
  }
}
```

### Pattern 2: Read-Only Dashboard (No Write API)

**What:** Dashboard exposes read-only API endpoints. All mutations happen through MCP tools (stdio transport only).

**When to use:** When dashboard is for monitoring/debugging, not primary interaction. Simplifies security model.

**Trade-offs:**
- **Pro:** No authentication needed (localhost only, read-only)
- **Pro:** Eliminates race conditions between HTTP writes and MCP writes
- **Pro:** Clear separation: agents write (stdio), humans read (HTTP)
- **Con:** Can't use dashboard to manually post blackboard entries or decisions (must use MCP client)

**Example:**
```typescript
// src/dashboard/routes.ts
import type { Express } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerDashboardRoutes(app: Express, getState: () => DashboardState) {
  // Read-only API routes
  app.get('/api/status', (req, res) => {
    const state = getState();
    res.json({
      blackboard_entries: state.blackboardStore.count(),
      active_decisions: state.decisionStore.countActive(),
      graph_entities: state.graphStore.countEntities(),
      last_activity: state.blackboardStore.getLastTimestamp()
    });
  });

  app.get('/api/blackboard', (req, res) => {
    const { limit = 50, entry_type } = req.query;
    const state = getState();
    const entries = state.blackboardStore.read({ limit, entry_type });
    res.json({ entries });
  });

  // No POST/PUT/DELETE routes - writes only via MCP tools
}
```

### Pattern 3: SSE for Real-Time Updates

**What:** Use Server-Sent Events (SSE) to push state updates to dashboard every 1 second.

**When to use:** For dashboards that need live data without client polling overhead.

**Trade-offs:**
- **Pro:** Efficient—single long-lived HTTP connection, server pushes when state changes
- **Pro:** Automatic reconnection if connection drops (native browser EventSource)
- **Pro:** Native browser API (EventSource), no library needed
- **Con:** Unidirectional (server → client only, but that's what we want for read-only dashboard)
- **Con:** ~1KB/s bandwidth per connected client (negligible for localhost)

**Example:**
```typescript
// src/dashboard/stream.ts
import type { Response } from 'express';

export function registerSSE(app: Express, getState: () => DashboardState) {
  app.get('/api/stream', (req, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const interval = setInterval(() => {
      const state = getState();
      res.write(`data: ${JSON.stringify({
        blackboard_count: state.blackboardStore.count(),
        decision_count: state.decisionStore.countActive(),
        last_activity: state.blackboardStore.getLastTimestamp()
      })}\n\n`);
    }, 1000); // Poll every 1 second

    req.on('close', () => clearInterval(interval));
  });
}
```

Client-side (vanilla JS):
```javascript
// src/dashboard/static/app.js
const eventSource = new EventSource('/api/stream');
eventSource.onmessage = (event) => {
  const state = JSON.parse(event.data);
  document.getElementById('blackboard-count').textContent = state.blackboard_count;
  document.getElementById('decision-count').textContent = state.decision_count;
};
```

### Pattern 4: No-Build Frontend (htmx + Alpine.js)

**What:** Use htmx for AJAX/HTML updates and Alpine.js for client-side state, avoiding build tooling.

**When to use:** When you want dynamic UI without npm build scripts, webpack, or React.

**Trade-offs:**
- **Pro:** Zero build step—copy static files as-is
- **Pro:** Tiny bundle size (htmx 14KB + Alpine.js 15KB = 29KB total)
- **Pro:** Server renders HTML, client enhances with minimal JS
- **Con:** Not suited for complex SPAs (but dashboard is simple CRUD UI)
- **Con:** Less tooling/IDE support than React/Vue

**Example:**
```html
<!-- src/dashboard/static/index.html -->
<!DOCTYPE html>
<html>
<head>
  <title>Twining Dashboard</title>
  <script src="/static/lib/htmx.min.js"></script>
  <script src="/static/lib/alpine.min.js" defer></script>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <!-- htmx fetches /api/blackboard and injects response here -->
  <div hx-get="/api/blackboard" hx-trigger="load, every 2s" hx-swap="innerHTML">
    Loading blackboard entries...
  </div>

  <!-- Alpine.js for client-side dropdown state -->
  <div x-data="{ open: false }">
    <button @click="open = !open">Toggle Filter</button>
    <div x-show="open">
      <!-- Filter UI -->
    </div>
  </div>
</body>
</html>
```

## Data Flow

### Request Flow (MCP Tool Call - UNCHANGED)

```
Claude Desktop
    ↓ (stdio, JSON-RPC)
StdioServerTransport
    ↓
MCP Server → Tool Handler (twining_post, twining_decide, etc.)
    ↓
Engine Layer (BlackboardEngine, DecisionEngine)
    ↓
Storage Layer (append to blackboard.jsonl, write decision JSON)
    ↓
File System (.twining/)
```

### Request Flow (Dashboard API - NEW)

```
Browser
    ↓ (HTTP GET /api/blackboard)
Express Router → Dashboard Route Handler
    ↓
getState() → Engine Layer
    ↓
Storage Layer (read blackboard.jsonl)
    ↓
JSON Response → Browser
```

### Real-Time Update Flow (SSE - NEW)

```
Browser (EventSource connected to /api/stream)
    ↑ (SSE, every 1 second)
Express SSE Route (polls getState())
    ↑
Engine Layer (read current counts/timestamps)
    ↑
Storage Layer (read file metadata, count lines)
```

### Key Data Flows

1. **Stdio writes, HTTP reads:** All mutations happen via MCP tools (stdio transport). Dashboard reads state via HTTP API.
2. **Shared engine layer:** Both transports access the same in-memory engine instances. No IPC, no state duplication.
3. **File-based synchronization:** Storage layer is single source of truth. Both transports read from .twining/ files.

## Integration Points

### New Components

| Component | File | Purpose |
|-----------|------|---------|
| **DashboardServer** | `src/dashboard/server.ts` | HTTP server setup (Express), listen on port 24282 |
| **DashboardRoutes** | `src/dashboard/routes.ts` | API endpoints (GET /api/status, /api/blackboard, /api/decisions, /api/graph) |
| **SSEHandler** | `src/dashboard/stream.ts` | Server-Sent Events for real-time state updates (1-second poll) |
| **StaticAssets** | `src/dashboard/static/` | HTML/JS/CSS (htmx + Alpine.js, no build step) |

### Modified Components

| Component | File | Modification |
|-----------|------|-------------|
| **MCP Server** | `src/server.ts` | Add `getDashboardState()` method exposing stores/engines for HTTP routes |
| **Entry Point** | `src/index.ts` | Conditionally start HTTP server after stdio transport connects |
| **Config Schema** | `src/config.ts` | Add `dashboard: { enabled: boolean, port: number }` (default: true, 24282) |

### Unchanged Components

All existing engine and storage code remains unchanged:
- `src/engine/` — Business logic, accessed by both transports
- `src/storage/` — File I/O, single source of truth
- `src/tools/` — MCP tool handlers, stdio transport only
- `src/embeddings/` — Embedding system, used by both transports via engine layer

## Scaling Considerations

| Scale | Dashboard Impact |
|-------|------------------|
| **Single user (localhost only)** | Default mode. HTTP server listens on 127.0.0.1:24282. No authentication needed. |
| **Team (local network)** | Bind to 0.0.0.0 if needed, but MUST add authentication (HTTP Basic Auth or API key). Warn in docs. |
| **Multi-instance (multiple MCP servers)** | Use port auto-increment (24282, 24283, ...) if default port in use. Display chosen port on startup. |

### Scaling Priorities

1. **First bottleneck:** SSE bandwidth with many clients. **Fix:** Increase poll interval from 1s to 5s or disable SSE for multiple clients.
2. **Second bottleneck:** Concurrent file reads (.twining/ files). **Fix:** Add in-memory caching layer with TTL (already partially solved by engine layer).

## Anti-Patterns

### Anti-Pattern 1: Write API in Dashboard

**What people do:** Add POST /api/blackboard to let dashboard post entries directly.

**Why it's wrong:** Creates two write paths (MCP tools + HTTP API), breaking the single-writer assumption of stdio transport. Requires authentication, CSRF protection, and race condition handling.

**Do this instead:** Dashboard is read-only. Use MCP client (Claude Desktop) to mutate state via stdio transport.

### Anti-Pattern 2: Build Step for Frontend

**What people do:** Use React/Vue with npm run build, webpack, etc.

**Why it's wrong:** Adds complexity, build dependencies, and deployment overhead for a simple monitoring UI.

**Do this instead:** Use htmx + Alpine.js (no build step). Vendor libraries in `src/dashboard/static/lib/`.

### Anti-Pattern 3: WebSockets for Updates

**What people do:** Use WebSocket for bidirectional real-time updates.

**Why it's wrong:** Dashboard doesn't need client → server messages (read-only). WebSockets add protocol complexity vs. SSE.

**Do this instead:** Use Server-Sent Events (SSE) for unidirectional server → client updates. Native browser API, automatic reconnect.

### Anti-Pattern 4: Separate Process for Dashboard

**What people do:** Run dashboard as separate Node.js process communicating via IPC or network.

**Why it's wrong:** Adds IPC complexity, state synchronization, and deployment overhead. Defeats the "embedded dashboard" goal.

**Do this instead:** Run HTTP server in same process as MCP server. Both access shared engine layer.

## Technology Stack

### HTTP Server

**Recommended:** Express.js (most popular, well-documented, minimal)

**Alternative:** Fastify (faster, but more complex for simple use case)

**Rationale:** Express has the largest ecosystem, simplest middleware model, and best htmx integration examples.

**Installation:**
```bash
npm install express @types/express
```

**Example:**
```typescript
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboardServer(getState: () => DashboardState, port: number) {
  const app = express();

  // Serve static files
  app.use('/static', express.static(path.join(__dirname, 'static')));

  // Register API routes
  registerDashboardRoutes(app, getState);
  registerSSE(app, getState);

  // Root redirect to dashboard
  app.get('/', (req, res) => res.redirect('/dashboard'));
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
  });

  app.listen(port, '127.0.0.1', () => {
    console.error(`[Dashboard] http://localhost:${port}/dashboard`); // stderr, not stdout (stdio transport)
  });

  return app;
}
```

### Frontend Stack

**Libraries:**
- **htmx** (14KB): AJAX requests, HTML swapping, polling
- **Alpine.js** (15KB): Client-side state, dropdowns, modals
- **No framework:** Vanilla HTML/CSS

**CDN vs. Vendored:**
- **Use vendored** (copy .min.js files into `src/dashboard/static/lib/`)
- **Don't use CDN** (dashboard must work offline on localhost)

**Installation:**
```bash
# Download vendored copies (one-time)
curl -o src/dashboard/static/lib/htmx.min.js https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js
curl -o src/dashboard/static/lib/alpine.min.js https://unpkg.com/alpinejs@3.14.3/dist/cdn.min.js
```

### SSE Implementation

**Library:** None (native Node.js `http` + `res.write()`)

**Example:**
```typescript
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = () => res.write(`data: ${JSON.stringify(getState())}\n\n`);
  const interval = setInterval(send, 1000);
  req.on('close', () => clearInterval(interval));
});
```

## Build Order

**Existing order (v1.0-v1.1):**
1. src/utils/ (types, ids, tokens)
2. src/storage/ (file-store, blackboard-store, decision-store, graph-store)
3. src/engine/ (blackboard, decisions, graph, context-assembler, archiver)
4. src/embeddings/ (embedder, index-manager, search)
5. src/tools/ (one file per tool group)
6. src/server.ts + src/index.ts (MCP registration and entry point)

**New order (v1.2 with dashboard):**
1. src/utils/ (types, ids, tokens) — UNCHANGED
2. src/storage/ (file-store, blackboard-store, decision-store, graph-store) — UNCHANGED
3. src/engine/ (blackboard, decisions, graph, context-assembler, archiver) — UNCHANGED
4. src/embeddings/ (embedder, index-manager, search) — UNCHANGED
5. src/tools/ (one file per tool group) — UNCHANGED
6. **src/dashboard/static/ (vendor htmx, Alpine.js, write index.html, app.js, style.css)** — NEW
7. **src/dashboard/routes.ts (API routes)** — NEW (depends on stores)
8. **src/dashboard/stream.ts (SSE handler)** — NEW (depends on stores)
9. **src/dashboard/server.ts (HTTP server init)** — NEW (depends on routes + stream)
10. src/server.ts (add `getDashboardState()` method) — MODIFIED
11. src/index.ts (conditionally start dashboard) — MODIFIED
12. src/config.ts (add dashboard config schema) — MODIFIED

**Rationale:** Dashboard is built after core MCP functionality is complete. Static assets come first (no dependencies), then routes (depend on stores), then server (depends on routes), then integration (modify entry point).

## Serena Reference Implementation

The Serena MCP server provides a proven reference for embedded dashboard architecture:

**Dashboard URL:** `http://localhost:24282/dashboard/index.html` (same port we'll use)

**Features:**
- Displays real-time logs
- Allows shutting down MCP server
- Always enabled by default (with flag to disable)
- Uses higher port if 24282 unavailable
- Prevents zombie processes by providing UI control

**Key Learnings:**
1. **Port selection:** 24282 is a good default (high port, unlikely to conflict, same as Serena)
2. **Default enabled:** Dashboard should be on by default (can disable via config)
3. **Localhost only:** Bind to 127.0.0.1, not 0.0.0.0 (security)
4. **Startup message:** Log dashboard URL to stderr (not stdout—would corrupt stdio transport)

**Differences from Serena:**
- Serena is Python/Flask, Twining will be TypeScript/Express
- Serena includes write actions (shutdown server), Twining dashboard is read-only
- Serena focuses on logs, Twining focuses on blackboard/decisions/graph visualization

## Dashboard UI Features

### Core Views

1. **Status Overview (/):** Stats, last activity, health
2. **Blackboard Timeline (/blackboard):** Recent entries, filterable by type/tags/scope
3. **Decisions (/decisions):** Active decisions, confidence levels, trace chains
4. **Graph Visualization (/graph):** Entity/relation explorer (simple table view, not interactive graph)
5. **Search (/search):** Semantic search across blackboard + decisions

### UI Components

| Component | Implementation | Notes |
|-----------|----------------|-------|
| **Live Stats** | SSE + Alpine.js counter | Blackboard count, decision count, last activity |
| **Entry Table** | htmx polling `/api/blackboard?limit=50` every 2s | Filterable, sortable |
| **Decision Detail** | htmx GET `/api/decisions/:id` on click | Modal overlay |
| **Graph Explorer** | htmx GET `/api/graph/neighbors/:id` | Expand/collapse neighbors |
| **Search Box** | htmx POST `/api/search` on input debounce | Instant results |

## Deployment Considerations

**No deployment changes needed.** Dashboard is embedded in the same process as MCP server.

**Distribution:**
- Package `src/dashboard/static/` in npm bundle (include in `files` array in package.json)
- Static assets copied to `dist/dashboard/static/` during `npm run build`

**Runtime:**
- Dashboard starts automatically when MCP server starts (unless disabled in config)
- No separate deployment step

**Security:**
- Localhost only (127.0.0.1) by default
- No authentication (trusted localhost environment)
- If exposing to network: MUST add HTTP Basic Auth or API key validation

## Sources

### MCP Architecture & Transport
- [Dual-Transport MCP Servers: STDIO vs. HTTP Explained](https://medium.com/@kumaran.isk/dual-transport-mcp-servers-stdio-vs-http-explained-bd8865671e1f) — Demonstrates running stdio and HTTP transports in same process with conditional initialization
- [Building an MCP Server the Official Way: STDIO Core + HTTP Gateway Explained](https://blog.popescul.com/posts/2026/01/15/mcp-server-official-way/) — Architecture patterns for dual-transport MCP servers
- [MCP Server Transports: STDIO, Streamable HTTP & SSE](https://docs.roocode.com/features/mcp/server-transports) — Technical details on MCP transport types

### Node.js HTTP & Express
- [Express serve-static middleware](https://expressjs.com/en/resources/middleware/serve-static.html) — Official documentation for serving static files in Express
- [Node.js HTTP server listen on multiple ports](https://onelinerhub.com/nodejs/http-server-listen-on-multiple-ports) — Confirms single Node.js process can listen on multiple ports
- [Express.js Middleware Architecture Deep Dive](https://www.grizzlypeaksoftware.com/library/expressjs-middleware-architecture-deep-dive-u03rb1on) — Middleware ordering and architecture patterns

### Server-Sent Events (SSE)
- [Why Server-Sent Events (SSE) are ideal for Real-Time Updates](https://talent500.com/blog/server-sent-events-real-time-updates/) — SSE vs polling vs WebSockets comparison
- [Understanding Server-Sent Events (SSE) with Node.js](https://itsfuad.medium.com/understanding-server-sent-events-sse-with-node-js-3e881c533081) — Implementation patterns for SSE in Node.js
- [WebSockets vs. SSE vs. Long Polling: Which Should You Use?](https://blog.openreplay.com/websockets-sse-long-polling/) — Technical comparison of real-time update strategies

### No-Build Frontend (htmx + Alpine.js)
- [HTMX and Alpine.js: How to combine two great, lean front ends](https://www.infoworld.com/article/3856520/htmx-and-alpine-js-how-to-combine-two-great-lean-front-ends.html) — Complementary use cases, no build step required
- [Why Developers Are Ditching Frameworks for Vanilla JavaScript](https://thenewstack.io/why-developers-are-ditching-frameworks-for-vanilla-javascript/) — Trend toward zero-build tooling in 2026
- [Django, HTMX and Alpine.js: Modern websites, JavaScript optional](https://www.saaspegasus.com/guides/modern-javascript-for-django-developers/htmx-alpine/) — Architecture patterns for htmx + Alpine.js

### Serena Reference Implementation
- [The Dashboard and GUI Tool — Serena Documentation](https://oraios.github.io/serena/02-usage/060_dashboard.html) — Official Serena dashboard implementation details
- [Serena MCP Setup Guide: Claude Code, Codex & JetBrains (2026)](https://smartscope.blog/en/generative-ai/claude/serena-mcp-implementation-guide/) — Dashboard configuration and usage patterns
- [GitHub - oraios/serena](https://github.com/oraios/serena) — Reference implementation source code

---
*Architecture research for: Embedded Dashboard Integration*
*Researched: 2026-02-16*
