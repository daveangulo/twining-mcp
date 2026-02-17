# Pitfalls Research: Embedded Web Dashboard for MCP Server

**Domain:** Adding HTTP dashboard to existing stdio-based MCP server
**Researched:** 2026-02-16
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: stdio Corruption from HTTP Logging

**What goes wrong:**
The HTTP server writes logs to stdout, corrupting the MCP stdio transport with non-JSON-RPC messages. The MCP client receives malformed JSON, breaking all tool calls. The server appears dead even though it's running.

**Why it happens:**
Node.js HTTP servers (Express, Fastify, etc.) default to console.log for request logging, which writes to stdout. MCP stdio transport requires clean stdout with only JSON-RPC messages delimited by newlines. Messages MUST NOT contain embedded newlines or non-protocol content. Even a single `console.log("Server started")` breaks the entire transport.

**How to avoid:**
1. **Never use console.log/console.info in any HTTP-related code** — only use stderr
2. Configure HTTP framework to log to stderr: `morgan('combined', { stream: process.stderr })`
3. Create a dedicated logger that only writes to stderr: `const log = (msg) => process.stderr.write(msg + '\n')`
4. Add a lint rule to catch console.log usage: `"no-console": ["error", { allow: ["error", "warn"] }]`
5. Test both transports independently before integration

**Warning signs:**
- MCP tools suddenly fail after HTTP server starts
- Claude shows "Invalid JSON-RPC response" errors
- `npx @modelcontextprotocol/inspector` shows corrupted messages
- Stdio works when HTTP server is disabled, fails when enabled

**Phase to address:**
Phase 1 (HTTP Server Setup) — enforce stderr-only logging from the start, include in initial testing checklist

---

### Pitfall 2: Port Binding Conflicts in Development

**What goes wrong:**
Server crashes on restart with EADDRINUSE because the previous HTTP server process is still holding the port. In MCP context, this is worse than typical Node.js apps because Claude spawns/kills the server frequently during development. The dashboard becomes unavailable even though the MCP server is running.

**Why it happens:**
When the server crashes (or Claude kills the process), the port isn't released immediately due to TIME_WAIT state in TCP. The MCP stdio transport terminates but the HTTP server hasn't cleaned up. On rapid restarts (common during development), the port is still bound.

**How to avoid:**
1. **Make port configurable with fallback**: If default port fails, try next port automatically
2. **Implement graceful HTTP shutdown**: `server.close()` on SIGTERM/SIGINT before process.exit
3. **Use SO_REUSEADDR**: Set `server.listen({ port, reusePort: true })` (Node 18.17+)
4. **Port selection strategy**:
   ```typescript
   async function findAvailablePort(startPort: number): Promise<number> {
     for (let port = startPort; port < startPort + 10; port++) {
       try {
         await new Promise((resolve, reject) => {
           const server = net.createServer();
           server.once('error', reject);
           server.once('listening', () => {
             server.close();
             resolve(port);
           });
           server.listen(port);
         });
         return port;
       } catch (err) {
         continue; // Try next port
       }
     }
     throw new Error('No available ports');
   }
   ```
5. **Configuration**: Let users specify port via config: `TWINING_DASHBOARD_PORT=3001`

**Warning signs:**
- "Error: listen EADDRINUSE: address already in use" in stderr
- Dashboard fails to start but MCP tools work
- Port conflicts with other dev servers (3000, 3001, 8080)
- Works first time, fails on second start

**Phase to address:**
Phase 1 (HTTP Server Setup) — implement port fallback and graceful shutdown before any frontend work

---

### Pitfall 3: Lazy-Load Failure Cascades to Dashboard

**What goes wrong:**
The dashboard tries to display embedding-based search results, but the embedding system failed to initialize (ONNX platform incompatibility). Instead of degrading gracefully, the dashboard shows error 500, breaking the entire UI. The constraint "server must never fail to start" is violated for the dashboard.

**Why it happens:**
The existing MCP server has graceful fallback for ONNX (see CLAUDE.md: "lazy-loaded, graceful fallback to keyword search if ONNX fails"). The dashboard code doesn't know about this constraint and assumes embeddings are always available. Dashboard endpoints call embedding functions without checking availability, throwing uncaught exceptions.

**How to avoid:**
1. **Add embedding availability flag**: `embedder.isAvailable(): boolean`
2. **Dashboard endpoints check before using**:
   ```typescript
   app.get('/api/search', async (req, res) => {
     if (!embedder.isAvailable()) {
       // Fall back to keyword search
       return res.json({ results: keywordSearch(req.query.q), mode: 'keyword' });
     }
     return res.json({ results: await semanticSearch(req.query.q), mode: 'semantic' });
   });
   ```
3. **Frontend shows degraded mode**: "Search (keyword mode - embeddings unavailable)"
4. **Never crash on embedding failure**: wrap all embedding calls in try/catch with fallback
5. **Test with ONNX disabled**: Run tests with embedding system artificially disabled

**Warning signs:**
- Dashboard works on Mac, fails on Linux ARM
- 500 errors in dashboard API but MCP tools work fine
- Errors mention "ONNX" or "embedding" in dashboard logs
- Search works via MCP tool, fails in dashboard

**Phase to address:**
Phase 2 (API Endpoints) — implement availability checks before exposing any search/query endpoints

---

### Pitfall 4: Large Graph Rendering Crashes Browser

**What goes wrong:**
Knowledge graph visualization renders all entities/relations at once. With 500+ entities, the browser freezes for 30+ seconds or crashes. Users can't interact with the dashboard. This defeats the purpose of a "human oversight" dashboard.

**Why it happens:**
Both D3.js and Cytoscape.js have well-documented performance issues with large graphs. D3 relies on SVG rendering which becomes slow with numerous elements (typically >200 nodes). Cytoscape.js has better canvas-based rendering but still struggles with rich visual styles, Bezier curves, and edge rendering at scale. The naive approach of `fetch('/api/graph').then(renderAll)` works for small projects but fails as the graph grows.

**How to avoid:**
1. **Implement pagination/filtering**: Only render subgraphs (depth=2 from selected entity)
2. **Use progressive rendering**:
   - Initial: Render only entities with >5 relations
   - Progressive: Load more on zoom/interaction
3. **Cytoscape.js performance options**:
   ```javascript
   const cy = cytoscape({
     hideEdgesOnViewport: true,  // Hide edges during pan/zoom
     textureOnViewport: true,     // Cache viewport as texture
     pixelRatio: 1,               // Lower for performance (vs. device ratio)
   });
   ```
4. **Simplify visual styles**: Avoid gradients, dashed lines, complex arrows
5. **Lazy load**: Don't fetch graph data until user clicks "Graph" tab
6. **Add performance budget**: Warn when graph exceeds 200 entities: "Large graph (500 entities) - use filters"

**Warning signs:**
- Dashboard responsive with small test project, freezes on real project
- Browser console shows "Unresponsive script" warnings
- Graph tab takes >5 seconds to render
- Memory usage spikes to >500MB in browser

**Phase to address:**
Phase 3 (Graph Visualization) — implement filtering/pagination from the start, NOT after performance problems appear

---

### Pitfall 5: Polling Performance Death Spiral

**What goes wrong:**
The dashboard polls `/api/status` every 1 second for live updates. With 10 browser tabs open (team using dashboard), the MCP server receives 10 requests/second, each reading all state files. File I/O spikes, MCP tool responses slow down (200ms → 2s), affecting Claude's actual work. The dashboard that was meant to help becomes a performance bottleneck.

**Why it happens:**
Polling-based updates seem simple but don't scale. Each poll reads `.twining/blackboard.jsonl`, `decisions/index.json`, `graph/entities.json`, `graph/relations.json`. With multiple tabs or team members, the load multiplies. The MCP server is single-threaded Node.js — file I/O blocks the event loop, delaying MCP tool responses.

**How to avoid:**
1. **Increase poll interval**: Start with 5 seconds, not 1 second
2. **Implement conditional polling**: Only poll when tab is active
   ```javascript
   document.addEventListener('visibilitychange', () => {
     if (document.hidden) {
       clearInterval(pollTimer);
     } else {
       pollTimer = setInterval(poll, 5000);
     }
   });
   ```
3. **Add caching layer**: Cache status for 2 seconds to serve multiple requests
   ```typescript
   let statusCache = { data: null, timestamp: 0 };
   app.get('/api/status', (req, res) => {
     if (Date.now() - statusCache.timestamp < 2000) {
       return res.json(statusCache.data);
     }
     statusCache = { data: await getStatus(), timestamp: Date.now() };
     res.json(statusCache.data);
   });
   ```
4. **Monitor poll rate**: Log warning if >20 requests/second
5. **Future: Consider SSE**: For v1.3+, migrate to Server-Sent Events for true push updates

**Warning signs:**
- MCP tool calls slow down when dashboard is open
- CPU usage spikes when multiple tabs open
- File read counts in monitoring show spikes
- Dashboard feels "laggy" despite simple UI

**Phase to address:**
Phase 2 (API Endpoints) — implement caching and visibility-based polling before Phase 3 UI

---

### Pitfall 6: Graceful Shutdown Race Condition

**What goes wrong:**
When Claude kills the MCP server (SIGTERM), the stdio transport closes immediately but the HTTP server is still serving dashboard requests. In-flight requests fail mid-response. Worse: if a dashboard poll is writing data (future POST endpoints), partial writes corrupt state files. The next MCP server start fails with "Invalid JSON" errors.

**Why it happens:**
Node.js process handlers are async and don't coordinate between subsystems. The default behavior is:
1. SIGTERM received
2. Stdio transport closes (fast, synchronous)
3. Process exits before HTTP server finishes response
4. File writes are interrupted mid-operation

The MCP SDK properly handles stdio cleanup but knows nothing about your HTTP server. You must coordinate shutdown between both transports.

**How to avoid:**
1. **Implement coordinated shutdown**:
   ```typescript
   let isShuttingDown = false;

   process.on('SIGTERM', async () => {
     if (isShuttingDown) return;
     isShuttingDown = true;

     // 1. Stop accepting new HTTP requests
     httpServer.close(() => {
       process.stderr.write('HTTP server closed\n');
     });

     // 2. Wait for in-flight requests (with timeout)
     await Promise.race([
       new Promise(resolve => httpServer.on('close', resolve)),
       new Promise(resolve => setTimeout(resolve, 5000)) // 5s timeout
     ]);

     // 3. Now safe to exit
     process.exit(0);
   });
   ```
2. **Reject new requests during shutdown**:
   ```typescript
   app.use((req, res, next) => {
     if (isShuttingDown) {
       res.status(503).send('Server shutting down');
     } else {
       next();
     }
   });
   ```
3. **Use file locking for writes**: Existing code uses `proper-lockfile` — ensure HTTP endpoints use it too
4. **Test shutdown**: Integration test that sends SIGTERM during active HTTP request

**Warning signs:**
- "Invalid JSON" errors on server restart
- Corrupted `.twining/*.json` files after crashes
- Dashboard shows 503 errors when Claude restarts server
- State files contain partial writes

**Phase to address:**
Phase 1 (HTTP Server Setup) — implement graceful shutdown BEFORE any state-modifying endpoints

---

### Pitfall 7: Static Asset Path Traversal Vulnerability

**What goes wrong:**
A crafted URL like `GET /../../../etc/passwd` reads arbitrary files from the filesystem. If the dashboard serves static files naively, attackers (or Claude itself, if misconfigured) can read sensitive files: `.env`, private keys, `~/.ssh/id_rsa`, other projects' code. This is a security vulnerability in a tool that Claude runs with the user's full filesystem access.

**Why it happens:**
Naive static file serving concatenates user input with filesystem paths without validation:
```typescript
// DANGEROUS
app.get('/assets/*', (req, res) => {
  const file = path.join(__dirname, req.params[0]); // ❌ No validation
  res.sendFile(file);
});
```

The `..` in paths allows traversal outside the intended directory. This is CVE-2023-26111 (node-static vulnerability) repeating. Express's `express.static()` has protections, but custom file-serving routes often don't.

**How to avoid:**
1. **Use framework built-ins**: `app.use('/assets', express.static('dashboard/dist'))` — they have path traversal protection
2. **If custom serving is required**:
   ```typescript
   app.get('/assets/*', (req, res) => {
     const requestedPath = path.normalize(req.params[0]).replace(/^(\.\.[\/\\])+/, '');
     const safePath = path.join(ASSETS_DIR, requestedPath);

     // Ensure resolved path is still within ASSETS_DIR
     if (!safePath.startsWith(ASSETS_DIR)) {
       return res.status(403).send('Forbidden');
     }

     res.sendFile(safePath);
   });
   ```
3. **Never serve from project root**: Only serve from bundled `dashboard/dist/`
4. **Validate all file paths**: Use `path.normalize()` and check resolved path
5. **Security test**: Include `curl http://localhost:3000/assets/../../.env` in test suite

**Warning signs:**
- Security scanner flags path traversal issues
- Custom file-serving code instead of framework middleware
- File paths constructed from user input without validation
- Access logs show `..` in requested URLs

**Phase to address:**
Phase 1 (HTTP Server Setup) — use secure static middleware from the start, add security tests in CI

---

### Pitfall 8: Asset Bundling Misconfiguration Breaks Deployment

**What goes wrong:**
Dashboard works perfectly in development (vite dev server) but breaks in production. The MCP server can't find bundled assets, returning 404 for all dashboard resources. Users see a blank page. This violates the constraint "server must never fail to start due to dashboard issues."

**Why it happens:**
Development uses Vite's dev server with hot reload. Production requires pre-bundled assets. The build process creates files in `dashboard/dist/` but the server code looks in the wrong location:
- Dev: `http://localhost:5173/` (Vite dev server)
- Prod: `http://localhost:3000/assets/` (needs correct static path)

Common mistakes:
- Forgetting to run `npm run build` before publishing
- Incorrect `base` path in Vite config
- Server looking for assets at `./dist/` instead of `./dashboard/dist/`
- Assets not included in npm package (`files` in package.json)

**How to avoid:**
1. **Correct Vite config**:
   ```javascript
   // vite.config.js
   export default {
     base: '/dashboard/',  // Must match server route prefix
     build: {
       outDir: '../dist/dashboard',  // Where server expects assets
       emptyOutDir: true
     }
   };
   ```
2. **Server serves from built location**:
   ```typescript
   const DASHBOARD_DIR = path.join(__dirname, '../dist/dashboard');
   app.use('/dashboard', express.static(DASHBOARD_DIR));
   ```
3. **Include in package.json**:
   ```json
   {
     "files": ["dist/**/*"],
     "scripts": {
       "build": "tsc && cd dashboard && npm run build"
     }
   }
   ```
4. **Graceful fallback**: If assets missing, serve minimal HTML with error message instead of 404
5. **Test production build**: CI runs `npm pack`, installs tarball, verifies dashboard loads

**Warning signs:**
- Dashboard works in dev, 404s in production
- Browser console: "Failed to load resource: /assets/index.js"
- `npm publish` succeeds but dashboard assets missing
- Users report blank dashboard page

**Phase to address:**
Phase 4 (Build/Deploy) — configure build pipeline correctly from the start, test with production builds

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| console.log for HTTP debugging | Fast iteration | stdio corruption, requires full refactor | Never — use stderr from day 1 |
| Hardcoded port 3000 | Simple config | Port conflicts, can't run multiple instances | Only for initial prototype (1 week max) |
| Render entire graph on load | Simple implementation | Browser crashes, unusable at scale | Only if project guaranteed <50 entities |
| Poll every 1 second | Feels responsive | Performance bottleneck, high CPU | Never — 5s minimum, use visibility API |
| Skip graceful shutdown | Faster development | Data corruption, hard-to-debug issues | Never — too risky with file-based state |
| Custom static file serving | Full control | Security vulnerabilities, reinventing wheel | Never — use framework middleware |
| Vite dev mode in production | Skips build step | Huge bundle size, slow startup, fails in npm | Never — always bundle for production |
| Single giant API endpoint | Less routing code | No caching, slow responses, hard to optimize | Only for MVP (Phase 2), refactor in Phase 3 |

## Integration Gotchas

Common mistakes when connecting HTTP dashboard to MCP server.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Logging | HTTP logs to stdout | Configure all HTTP logging to stderr: `morgan('combined', { stream: process.stderr })` |
| State access | Duplicate file reads (HTTP + MCP) | Share store instances between stdio and HTTP handlers |
| Error handling | HTTP 500 kills entire server | Isolate HTTP errors: never let them crash stdio transport |
| Polling | Client polls multiple endpoints | Single `/api/status` endpoint with combined data |
| File locking | HTTP bypasses `proper-lockfile` | All HTTP writes use same locking as MCP tools |
| Embedding fallback | Assume embeddings always work | Check `embedder.isAvailable()` in HTTP handlers |
| Process lifecycle | HTTP and stdio shut down independently | Coordinate shutdown: HTTP closes before process.exit |
| Configuration | Separate configs for HTTP/MCP | Single `.twining/config.yml` for both transports |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Read all state on every poll | Dashboard lags, MCP tools slow | Cache status for 2s, use visibility API | >100 blackboard entries or >5 concurrent users |
| Render all graph entities | Browser freeze, 100% CPU | Pagination, depth-limited subgraph rendering | >200 entities |
| Synchronous file I/O in HTTP handlers | Blocking, request timeout | Use async fs.promises, stream large files | >50 requests/second |
| No debouncing on search input | API spam, high CPU | Debounce 300ms, cancel previous request | >20 char typed quickly |
| Fetch entire blackboard for search | Memory spike, slow response | Stream JSONL, limit results to 100 | >1000 entries |
| Embed all decisions at once | ONNX CPU spike, request timeout | Lazy embed, batch with delays | >500 decisions |
| Re-parse all JSONL on each request | CPU spike, slow response | Parse once, keep in-memory cache, invalidate on write | >2000 lines in blackboard.jsonl |
| No HTTP compression | Slow dashboard load, high bandwidth | Enable gzip: `app.use(compression())` | >1MB JSON responses |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Custom static file serving | Path traversal, arbitrary file read | Use `express.static()` with proper root |
| Serving from project root | Exposes .env, private keys, source code | Only serve from bundled `dist/dashboard/` |
| No CORS headers | Dashboard accessible from any origin | Not critical (localhost only) but set `Access-Control-Allow-Origin: http://localhost:*` |
| Exposing internal file paths | Information leakage | Return relative paths only: `/src/auth/jwt.ts` not `/Users/dave/project/src/auth/jwt.ts` |
| No input validation on search | Injection into file system operations | Validate query length, sanitize special chars |
| POST endpoints without CSRF | Cross-site request forgery (future v1.3) | Add CSRF tokens before implementing writes |
| Embedding model path from user | Arbitrary code execution | Hardcode model path, never from config/env |
| Unrestricted file export | Can export any file via crafted request | Validate export scope against `.twining/` only |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No loading states | Dashboard appears broken during slow operations | Show spinners, skeleton screens for >500ms operations |
| Silent embedding fallback | Users don't know search is degraded | Show badge: "Search (keyword mode)" when embeddings unavailable |
| No error recovery | One failed poll breaks dashboard permanently | Retry with exponential backoff, show reconnecting state |
| Graph loads on dashboard open | 10s blank screen before graph appears | Lazy load: "Click to load graph (200 entities)" |
| Raw timestamps | Hard to understand "2026-02-16T14:32:11.423Z" | Show relative: "2 minutes ago", hover for full timestamp |
| No empty states | Blank screen for new projects | Show "No decisions yet - make one with twining_decide" |
| All data in one table | Overwhelming for large projects | Tabs: Recent / Decisions / Warnings / Needs |
| No keyboard navigation | Forces mouse use for everything | Add shortcuts: `/` for search, `d` for decisions, `g` for graph |
| Polling when tab inactive | Battery drain, wasted CPU | Stop polling when document.hidden, resume when visible |
| No data staleness indicator | Users don't know if dashboard is frozen | Show "Last updated: 3s ago" with color coding |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **HTTP Server**: Often missing stderr logging config — verify `morgan` output doesn't corrupt stdio
- [ ] **HTTP Server**: Often missing graceful shutdown — verify SIGTERM closes HTTP before exit
- [ ] **Port Binding**: Often missing fallback logic — verify handles EADDRINUSE gracefully
- [ ] **Static Assets**: Often missing production build — verify `npm pack` includes dashboard/dist/
- [ ] **Static Assets**: Often missing security validation — verify path traversal test fails
- [ ] **Polling**: Often missing visibility check — verify polling stops when tab hidden
- [ ] **API Endpoints**: Often missing embedding availability check — verify works with ONNX disabled
- [ ] **API Endpoints**: Often missing caching — verify multiple requests don't re-read files
- [ ] **Graph Viz**: Often missing performance limits — verify 500+ entities doesn't freeze browser
- [ ] **Search**: Often missing debounce — verify rapid typing doesn't spam API
- [ ] **Error States**: Often missing retry logic — verify failed poll doesn't break dashboard permanently
- [ ] **Empty States**: Often missing new project UX — verify blank project shows helpful message
- [ ] **Build Pipeline**: Often missing Vite base path — verify bundled assets load correctly
- [ ] **Integration**: Often missing dual-transport test — verify MCP and HTTP work simultaneously
- [ ] **Shutdown**: Often missing in-flight request handling — verify SIGTERM during poll doesn't corrupt state

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| stdio corruption | LOW | 1. Kill server, 2. Grep code for console.log, 3. Replace with stderr writes, 4. Restart |
| Port conflict | LOW | 1. Kill process on port: `lsof -ti:3000 \| xargs kill`, 2. Or change port in config |
| Embedding fallback broken | MEDIUM | 1. Add isAvailable() check, 2. Wrap in try/catch, 3. Test with ONNX disabled |
| Graph performance | HIGH | 1. Add immediate limit (top 100 entities), 2. Refactor to pagination (days), 3. Add filtering |
| Polling death spiral | MEDIUM | 1. Increase interval to 10s, 2. Add caching (hours), 3. Migrate to SSE (v1.3) |
| Shutdown race | MEDIUM | 1. Check for corrupted JSON files, 2. Restore from git, 3. Add coordinated shutdown |
| Path traversal | LOW | 1. Switch to express.static(), 2. Add security test, 3. Audit custom routes |
| Asset bundling | LOW | 1. Fix Vite base path, 2. Rebuild, 3. Verify in production mode, 4. Update package.json files |
| Data corruption from crash | HIGH | 1. Restore from git/backup, 2. Check `.twining/` for partial writes, 3. Re-run archiver if needed |
| Browser crash from large graph | LOW | 1. Refresh page, 2. Use filters before opening graph tab, 3. Wait for pagination fix |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| stdio corruption | Phase 1 (HTTP Setup) | Test: HTTP server starts, MCP tools still work, no stdout pollution |
| Port conflicts | Phase 1 (HTTP Setup) | Test: Start server twice rapidly, second finds new port |
| Embedding fallback | Phase 2 (API Endpoints) | Test: Disable ONNX, verify search returns keyword results not errors |
| Large graph rendering | Phase 3 (Graph Viz) | Test: Generate 500 entities, verify pagination/filtering works |
| Polling performance | Phase 2 (API Endpoints) | Test: 10 concurrent tabs, verify MCP latency <100ms |
| Shutdown race | Phase 1 (HTTP Setup) | Test: SIGTERM during HTTP request, verify no corrupted files |
| Path traversal | Phase 1 (HTTP Setup) | Test: `curl /assets/../../.env` returns 403 |
| Asset bundling | Phase 4 (Build/Deploy) | Test: `npm pack && npm install tarball`, verify dashboard loads |

## Sources

### Node.js and HTTP Server Best Practices
- [How to Build a Graceful Shutdown Handler in Node.js](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view) - Graceful shutdown patterns for coordinating subsystems
- [Graceful Shutdown for Node.js in two easy steps](https://www.amazee.io/blog/post/graceful-shutdown-for-node-js-in-two-easy-steps/) - Close empty connections, wait for pending
- [How to Fix "Error: listen EADDRINUSE" in Node.js](https://oneuptime.com/blog/post/2026-01-25-fix-eaddrinuse-nodejs/view) - Port conflict handling strategies

### MCP Transport and stdio/HTTP Coexistence
- [Dual-Transport MCP Servers: STDIO vs. HTTP Explained](https://medium.com/@kumaran.isk/dual-transport-mcp-servers-stdio-vs-http-explained-bd8865671e1f) - Architecture for supporting both transports
- [Demystifying LLM MCP Servers: Debugging stdio Transports Like a Pro](https://jianliao.github.io/blog/debug-mcp-stdio-transport) - Logging breaks stdio protocol
- [Model Context Protocol - Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) - Messages delimited by newlines, MUST NOT contain embedded newlines

### Graph Visualization Performance
- [Performance Optimization - Cytoscape.js](https://deepwiki.com/cytoscape/cytoscape.js/8-performance-optimization) - hideEdgesOnViewport, textureOnViewport, pixelRatio settings
- [The Best Libraries to Render Large Force-Directed Graphs](https://weber-stephen.medium.com/the-best-libraries-and-methods-to-render-large-network-graphs-on-the-web-d122ece2f4dc) - D3 SVG limitations, Canvas strategies
- [Slow style rendering for large graphs - Issue #2169](https://github.com/cytoscape/cytoscape.js/issues/2169) - Memory consumption, rendering complexity pitfalls

### Polling vs Real-time Updates
- [WebSockets vs Server-Sent Events vs Long Polling](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html) - Comparison of real-time communication patterns
- [Socket.io vs WebSockets vs Server-Sent Events: Real-Time Communication Comparison 2026](https://www.index.dev/skill-vs-skill/socketio-vs-websockets-vs-server-sent-events) - SSE ideal for dashboard updates

### Security
- [Node.js Security Release Patches 7 Vulnerabilities](https://cyberpress.org/node-js-security-release-patches-7-vulnerabilities-across-all-release-lines/) - Path traversal via symlinks, permission bypasses
- [The security vulnerability of serving images via a route](https://www.nodejs-security.com/blog/security-vulnerability-serving-images-via-route-nodejs) - Custom file serving dangers vs Express static middleware
- [Unrestricted File Download in NodeJS](https://knowledge-base.secureflag.com/vulnerabilities/unrestricted_file_download/unrestricted_file_download_nodejs.html) - Path traversal prevention

### Build Tooling
- [Vite 6 SSR Streaming](https://johal.in/vite-6-ssr-streaming-python-react-server-components-esbuild-rollup-2026/) - Esbuild + Rollup hybrid, sub-second builds
- [Static Asset Handling - Vite](https://vite.dev/guide/assets) - Production bundling, base path configuration

---
*Pitfalls research for: Embedded Web Dashboard for Twining MCP Server*
*Researched: 2026-02-16*
