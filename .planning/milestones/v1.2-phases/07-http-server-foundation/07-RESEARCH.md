# Phase 7: HTTP Server Foundation - Research

**Researched:** 2026-02-16
**Domain:** Embedded HTTP server alongside MCP stdio transport
**Confidence:** HIGH

## Summary

Phase 7 adds an embedded HTTP server to twining-mcp that runs in the same Node.js process as the MCP stdio server. The HTTP server serves static HTML/CSS/JS assets (no build step) and provides the foundation for later phases to add data APIs and interactive visualizations. The critical constraint is that HTTP server activity must never corrupt MCP stdio transport -- all logging must go to stderr, and dashboard startup must be non-blocking.

The existing codebase already follows the stderr-only logging discipline (`console.error` throughout, with a code comment in `index.ts` warning against `console.log`). The native Node.js `http` module is sufficient for this use case -- no Express or Fastify needed. Port configuration uses environment variables (following Serena's pattern), and port conflict handling uses a simple retry-next-port approach. Browser auto-open uses the `open` npm package (ESM-native, cross-platform). Graceful shutdown ties the HTTP server lifecycle to process exit signals.

**Primary recommendation:** Use Node.js native `http.createServer` with a custom static file handler, the `open` npm package for browser launching, and environment variables for configuration. Keep the HTTP server startup non-blocking and independent of MCP initialization to avoid Serena's timeout bug.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | Dashboard HTTP server starts automatically alongside MCP stdio server in the same process | Native `http.createServer` called from `index.ts` after MCP server connects; non-blocking startup pattern prevents Serena's timeout bug |
| INFRA-02 | Dashboard serves static HTML/CSS/JS assets with no build step required | Custom static file handler using `fs.readFile` + MIME type map; assets embedded in `src/dashboard/public/` and compiled to `dist/dashboard/public/` |
| INFRA-03 | Dashboard port is configurable via environment variable with sensible default (24282) | `TWINING_DASHBOARD_PORT` env var; default 24282 (same as Serena, hex 0x5EDA) |
| INFRA-04 | Dashboard auto-opens browser on server start (configurable, can be disabled) | `open` npm package (v11, ESM-native); disabled via `TWINING_DASHBOARD_NO_OPEN=1` env var |
| INFRA-05 | Dashboard gracefully handles port conflicts by trying subsequent ports | Catch `EADDRINUSE` in `server.on('error')`, retry with port+1 up to max retries (5) |
| INFRA-06 | Dashboard HTTP output never corrupts MCP stdio transport (all logging to stderr) | Already enforced project-wide; HTTP server uses `console.error` for all output; `process.stdout` is exclusively owned by MCP transport |
| INFRA-07 | Dashboard shuts down gracefully when MCP server exits | `process.on('SIGTERM'/'SIGINT')` calls `httpServer.close()`; also hook into MCP server close event |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:http` | (built-in) | HTTP server | Zero dependencies; sufficient for static file serving + simple JSON APIs; already a project design decision |
| `node:fs/promises` | (built-in) | Async file reading for static assets | Native async I/O, no extra deps |
| `node:path` | (built-in) | Path resolution and security | Needed for safe path joining and traversal prevention |
| `open` | ^11.0.0 | Cross-platform browser opening | Standard solution; ESM-native; handles macOS/Windows/Linux differences; uses spawn (not exec) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:child_process` | (built-in) | Fallback browser opening | Only if `open` package unavailable; use `spawn` with platform-specific commands |
| `node:url` | (built-in) | URL parsing | For parsing request URLs safely |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:http` | Express.js | Express adds ~1.8MB deps; unnecessary for static files + simple JSON; project decision already locks native http |
| `node:http` | Fastify | Same as Express; even less justified for static-only serving |
| `open` package | Manual `child_process.exec` | Fragile cross-platform handling; `open` handles edge cases (WSL, sandboxed environments, PowerShell fallbacks) |
| Custom MIME map | `mime-types` package | Package covers ~1000 types; we only need ~10 (html, css, js, json, svg, png, ico); hand-rolled map is fine |

**Installation:**
```bash
npm install open
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── dashboard/
│   ├── http-server.ts       # HTTP server creation, static file serving, port management
│   ├── dashboard-config.ts  # Dashboard configuration (port, auto-open, enable/disable)
│   └── public/              # Static assets (HTML, CSS, JS) -- no build step
│       ├── index.html       # Dashboard shell page
│       ├── style.css        # Base styles
│       └── app.js           # Client-side JavaScript
├── index.ts                 # Modified: start dashboard after MCP connects
├── server.ts                # Unchanged: MCP tool registration
└── ...existing modules...
```

### Pattern 1: Non-Blocking Dashboard Startup
**What:** Start the HTTP server AFTER MCP stdio transport connects, using a fire-and-forget async call that never blocks or rejects to the MCP startup path.
**When to use:** Always -- this prevents the Serena timeout bug where dashboard startup failure blocked MCP initialization.
**Example:**
```typescript
// src/index.ts
async function main(): Promise<void> {
  const server = createServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);  // MCP is now ready

  // Dashboard starts after MCP -- never blocks, never throws to main
  startDashboard(projectRoot).catch((err) => {
    console.error("[twining] Dashboard failed to start (non-fatal):", err.message);
  });
}
```

### Pattern 2: Port Retry with EADDRINUSE
**What:** When the configured port is in use, try subsequent ports up to a retry limit.
**When to use:** INFRA-05 requirement.
**Example:**
```typescript
function tryListen(server: http.Server, port: number, maxRetries: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function attempt(currentPort: number) {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts < maxRetries) {
          attempts++;
          attempt(currentPort + 1);
        } else {
          reject(err);
        }
      });
      server.listen(currentPort, '127.0.0.1', () => {
        resolve(currentPort);
      });
    }

    attempt(port);
  });
}
```

### Pattern 3: Static File Server with Security
**What:** Serve files from a known directory with path traversal prevention and correct MIME types.
**When to use:** INFRA-02 requirement.
**Example:**
```typescript
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(publicDir: string) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    let filePath = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);

    // Path traversal prevention
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(publicDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Serve the file
    try {
      const data = await fs.readFile(resolved);
      const ext = path.extname(resolved);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  };
}
```

### Pattern 4: Graceful Shutdown
**What:** Close the HTTP server when the process exits, ensuring no dangling connections.
**When to use:** INFRA-07 requirement.
**Example:**
```typescript
function setupShutdown(httpServer: http.Server): void {
  const shutdown = () => {
    console.error("[twining] Dashboard shutting down...");
    httpServer.close(() => {
      console.error("[twining] Dashboard stopped.");
    });
    // Force close after timeout
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
```

### Pattern 5: Environment Variable Configuration
**What:** Read dashboard config from environment variables with sensible defaults.
**When to use:** INFRA-03, INFRA-04 requirements.
**Example:**
```typescript
interface DashboardConfig {
  port: number;
  enabled: boolean;
  autoOpen: boolean;
}

function getDashboardConfig(): DashboardConfig {
  return {
    port: parseInt(process.env.TWINING_DASHBOARD_PORT || '24282', 10),
    enabled: process.env.TWINING_DASHBOARD !== '0',
    autoOpen: process.env.TWINING_DASHBOARD_NO_OPEN !== '1',
  };
}
```

### Anti-Patterns to Avoid
- **Blocking MCP startup on dashboard:** Serena hit this exact bug (issue #648) -- dashboard startup failure caused a 60-second timeout preventing MCP client connection. Dashboard startup MUST be fire-and-forget after MCP connects.
- **Writing to stdout from HTTP handler:** The MCP StdioServerTransport owns `process.stdout` exclusively. Any `console.log` or `process.stdout.write` from HTTP code will corrupt JSON-RPC messages. Use `console.error` only.
- **Synchronous file reads in request handler:** Use `fs.readFile` (async), never `fs.readFileSync`, in the HTTP request path to avoid blocking the event loop.
- **Serving files outside the public directory:** Always resolve paths and verify they start with the public directory root to prevent path traversal attacks.
- **Listening on 0.0.0.0 by default:** Bind to `127.0.0.1` (localhost only) for security. This is a developer tool, not a public-facing server.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-platform browser opening | Platform detection + child_process.exec | `open` npm package | Handles WSL, sandboxed Linux, PowerShell fallbacks, macOS app names; 15+ edge cases |
| HTTP request routing (later phases) | Regex-based URL matching | Simple switch/if-else on `req.url` prefix | For Phase 7 we only need `/` and `/api/` prefixes; full routing is YAGNI |
| MIME type detection | Full MIME database | 10-entry object literal | We control which file types exist in `public/`; full MIME DB is ~200KB of waste |

**Key insight:** The dashboard is a developer tool serving known static assets from a controlled directory. Production-grade HTTP server features (caching, ETags, range requests, gzip, virtual hosts) are unnecessary and add complexity.

## Common Pitfalls

### Pitfall 1: Dashboard Blocks MCP Initialization
**What goes wrong:** If the HTTP server fails to start (port in use, permission error), and this is awaited in the main startup path, the MCP client times out waiting for the JSON-RPC handshake.
**Why it happens:** Natural instinct is to `await startDashboard()` before proceeding. But MCP clients have connection timeouts (Serena hit 60 seconds).
**How to avoid:** Start dashboard with `.catch()` after MCP `server.connect(transport)` resolves. Dashboard failure is non-fatal.
**Warning signs:** MCP client reports "connection timeout" when dashboard is enabled but port is unavailable.

### Pitfall 2: stdout Corruption
**What goes wrong:** HTTP server or its dependencies write to stdout, corrupting the JSON-RPC byte stream.
**Why it happens:** Many npm packages use `console.log` internally. The `http` core module does not, but third-party middleware or logging libraries might.
**How to avoid:** (a) Use only `node:http` with no middleware, (b) Never use `console.log` in any dashboard code, (c) Test by running the MCP server and verifying tools work while dashboard is active.
**Warning signs:** MCP client reports "parse error" or "invalid JSON" intermittently.

### Pitfall 3: Port Retry Race Condition
**What goes wrong:** The `error` event listener from a previous `listen()` attempt fires for the new attempt, causing double-handling.
**Why it happens:** Not removing the previous `error` listener before retrying with a new port.
**How to avoid:** Use `server.once('error', ...)` instead of `server.on('error', ...)` so the listener auto-removes after firing.
**Warning signs:** Server reports multiple "port in use" errors for the same port, or starts on wrong port.

### Pitfall 4: Static Assets Not Found After Build
**What goes wrong:** HTML/CSS/JS files exist in `src/dashboard/public/` but are not present in `dist/dashboard/public/` after `tsc` build.
**Why it happens:** TypeScript compiler only processes `.ts` files. Static assets need to be copied separately.
**How to avoid:** Either (a) add a copy step to the build script, (b) reference assets relative to the source directory, or (c) use `__dirname` to resolve to the correct location at runtime. The recommended approach is to resolve `public/` relative to the compiled JS file using `import.meta.url`.
**Warning signs:** 404 errors for all static assets when running from `dist/`.

### Pitfall 5: Open Browser in Headless/CI Environment
**What goes wrong:** `open` package tries to launch a browser in a headless server or CI environment, causing errors or hanging.
**Why it happens:** No display server available.
**How to avoid:** Wrap `open()` call in try/catch, log failure to stderr, and continue. The `TWINING_DASHBOARD_NO_OPEN=1` env var provides a manual override.
**Warning signs:** Process hangs or emits "spawn xdg-open ENOENT" errors.

## Code Examples

Verified patterns from official sources and codebase analysis:

### HTTP Server Creation (node:http)
```typescript
// Source: Node.js v25 docs - http.createServer
import http from 'node:http';

const server = http.createServer((req, res) => {
  // Request handler
});

server.listen(24282, '127.0.0.1', () => {
  console.error(`[twining] Dashboard: http://127.0.0.1:24282`);
});
```

### Static Asset Path Resolution (ESM)
```typescript
// Source: Node.js ESM docs - import.meta.url
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
```

### Browser Auto-Open
```typescript
// Source: open package v11 README
import open from 'open';

async function openBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch (err) {
    console.error(`[twining] Could not open browser (non-fatal): ${(err as Error).message}`);
  }
}
```

### Environment Variable Parsing
```typescript
// Following existing codebase pattern (no process.env usage yet; this is the first)
const port = parseInt(process.env.TWINING_DASHBOARD_PORT || '24282', 10);
const enabled = process.env.TWINING_DASHBOARD !== '0';
const autoOpen = process.env.TWINING_DASHBOARD_NO_OPEN !== '1';
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Express.js for simple static serving | Native `node:http` + `fs/promises` | 2023+ (trend) | Zero deps for simple use cases; Express still standard for complex APIs |
| `__dirname` in CommonJS | `import.meta.url` + `fileURLToPath` in ESM | Node 12+ / ESM adoption | Required since project uses `"type": "module"` |
| `open` package CJS export | ESM-only (v10+) | Nov 2023 (v10.0.0) | Project already ESM; no issue |
| Serena: FastAPI dashboard | Serena: Flask dashboard | 2025 (Serena v0.6+) | Simplified to avoid asyncio conflicts; our Node.js case is simpler (single event loop) |

**Deprecated/outdated:**
- Using `require('http')` -- project is ESM; use `import http from 'node:http'`
- Using `fs.readFileSync` in request handlers -- use async `fs.readFile` or `fs/promises`
- Binding to `0.0.0.0` for dev tools -- always `127.0.0.1` for security

## Open Questions

1. **Static asset copying in build pipeline**
   - What we know: TypeScript compiler does not copy non-TS files. Static HTML/CSS/JS in `src/dashboard/public/` will not appear in `dist/`.
   - What's unclear: Best approach for this project's build setup.
   - Recommendation: Add a `"prebuild"` or `"postbuild"` script to `package.json` that copies `src/dashboard/public/` to `dist/dashboard/public/`. Alternatively, resolve the public directory relative to the source tree using `import.meta.url` and the known project structure. The `import.meta.url` approach is simpler and avoids build script changes, but means source assets must be present at runtime (fine for `npx` usage where both `dist/` and `src/` are in the package).

2. **API route structure for later phases**
   - What we know: Phase 8 will need `/api/status`, `/api/blackboard`, `/api/decisions`, `/api/graph` endpoints. Phase 7 only needs static file serving.
   - What's unclear: Whether to set up the routing skeleton now or defer.
   - Recommendation: Add a minimal API handler placeholder (just `/api/health` returning `{"ok":true}`) in Phase 7. This validates the routing pattern works without over-building. Later phases fill in the actual data endpoints.

3. **Dashboard enable/disable default**
   - What we know: INFRA-01 says "starts automatically." Serena starts it by default and had issues (#268, #648).
   - What's unclear: Whether dashboard should default to enabled or disabled.
   - Recommendation: Default to enabled (matching requirement INFRA-01), but with non-blocking startup so failure is silent. Users can disable with `TWINING_DASHBOARD=0`.

## Sources

### Primary (HIGH confidence)
- Node.js v25.6.1 `http` module documentation -- server creation, listen, close, error handling
- Node.js v25.6.1 `process` documentation -- signal handling (SIGTERM, SIGINT), stderr
- MCP SDK `StdioServerTransport` source code (npm `@modelcontextprotocol/sdk` v1.26.0) -- verified stdout ownership, stdin/stdout binding
- Existing twining-mcp codebase (`src/index.ts`, `src/server.ts`, `src/config.ts`, `src/utils/types.ts`) -- architecture patterns, logging discipline, test patterns

### Secondary (MEDIUM confidence)
- [Serena MCP server](https://github.com/oraios/serena) -- reference implementation for embedded dashboard pattern, port 24282 default, auto-open, port increment
- [Serena issue #648](https://github.com/oraios/serena/issues/648) -- dashboard blocking MCP startup (critical pitfall)
- [Serena issue #268](https://github.com/oraios/serena/issues/268) -- auto-open browser configuration
- [`open` npm package](https://github.com/sindresorhus/open) v11.0.0 -- ESM-native, cross-platform browser opening API
- [MDN: Node server without framework](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Server-side/Node_server_without_framework) -- static file serving patterns

### Tertiary (LOW confidence)
- Various web search results on EADDRINUSE retry patterns -- common community knowledge, verified against Node.js docs
- Web search results on graceful shutdown patterns -- verified against Node.js process docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Using only Node.js built-ins plus one well-known package (`open`); all verified against official docs
- Architecture: HIGH - Pattern validated by Serena reference implementation; pitfalls documented from real bug reports
- Pitfalls: HIGH - Primary pitfall (blocking MCP startup) confirmed by Serena issue #648; stdout corruption verified by reading MCP SDK source

**Research date:** 2026-02-16
**Valid until:** 2026-04-16 (stable domain; Node.js http module is mature)
