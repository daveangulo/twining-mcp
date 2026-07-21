/**
 * Embedded HTTP server for the Twining dashboard.
 *
 * CRITICAL: Never use console.log or process.stdout in this module.
 * The MCP StdioServerTransport owns stdout exclusively — any writes
 * corrupt the JSON-RPC byte stream.
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardConfig } from "./dashboard-config.js";
import { createApiHandler, type DashboardDeps } from "./api-routes.js";
import { createQueryHandler } from "./query-routes.js";

/**
 * Check if a Twining dashboard for the SAME project is already running on the given port.
 * Returns true only when another instance serves the same projectRoot.
 * Different-project dashboards are not considered duplicates.
 */
/** Port-increment retries for EADDRINUSE, and the guard's probe window (#42). */
const DASHBOARD_PORT_RETRIES = 5;

function isExistingDashboard(
  port: number,
  projectRoot: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/api/health", timeout: 1000 },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(
              data.server === "twining-mcp" &&
                data.projectRoot === projectRoot,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** MIME types for static assets served from the public directory. */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Create a static file serving handler for the given directory.
 * Includes path traversal prevention (403) and 404 for missing files.
 */
function serveStatic(
  publicDir: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Parse URL to strip query strings, but use raw pathname for traversal check
    const rawUrl = req.url || "/";
    const qIndex = rawUrl.indexOf("?");
    const rawPath = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const decodedPath = decodeURIComponent(rawPath);
    const pathname = decodedPath === "/" ? "/index.html" : decodedPath;
    const filePath = path.join(publicDir, pathname);

    // Path traversal prevention
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(publicDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const data = await fs.readFile(resolved);
      const ext = path.extname(resolved);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      });
      res.end(data);
    } catch (err: unknown) {
      const code =
        err instanceof Error && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        res.writeHead(404);
        res.end("Not Found");
      } else {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  };
}

/**
 * Attempt to bind the server to a port, retrying on EADDRINUSE.
 * Returns the actual port the server bound to.
 */
function tryListen(
  server: http.Server,
  port: number,
  maxRetries: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function attempt(currentPort: number): void {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempts < maxRetries) {
          attempts++;
          attempt(currentPort + 1);
        } else {
          reject(err);
        }
      });
      server.listen(currentPort, "127.0.0.1", () => {
        // When port is 0, OS assigns a random port — read the actual port
        const addr = server.address();
        const actualPort =
          typeof addr === "object" && addr !== null ? addr.port : currentPort;
        resolve(actualPort);
      });
    }

    attempt(port);
  });
}

/**
 * Create a request handler that routes between API and static files.
 * API routes are checked first, then health check, then static files.
 */
export function handleRequest(
  publicDir: string,
  projectRoot: string,
  deps?: DashboardDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const staticHandler = serveStatic(publicDir);
  const queryHandler = createQueryHandler(projectRoot, deps);
  const apiHandler = createApiHandler(projectRoot, deps);
  const resolvedProjectRoot = path.resolve(projectRoot);

  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Try scale-oriented query routes first, then the existing API routes (async)
    queryHandler(req, res)
      .then((queryHandled) => (queryHandled ? true : apiHandler(req, res)))
      .then((handled) => {
        if (handled) return;

        // Health check endpoint
        if (req.url === "/api/health") {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(
            JSON.stringify({
              ok: true,
              server: "twining-mcp",
              projectRoot: resolvedProjectRoot,
            }),
          );
          return;
        }

        // Fall through to static file serving
        return staticHandler(req, res);
      })
      .catch((err: unknown) => {
        console.error("[twining] Request handler error:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });
  };
}

/**
 * Start the dashboard HTTP server.
 * Returns the server and actual port, or null if the dashboard is disabled.
 *
 * @param projectRoot - The project root directory (used for API data access)
 * @param deps - Shared store/engine instances from the MCP server; omitted in
 *   standalone mode, in which the API handler constructs its own.
 */
export async function startDashboard(
  projectRoot: string,
  deps?: DashboardDeps,
): Promise<{ server: http.Server; port: number } | null> {
  const config = getDashboardConfig();
  if (!config.enabled) {
    return null;
  }

  // Single-instance guard (#42): if another twining server already serves
  // THIS project's dashboard, don't start a second one — the second
  // instance (e.g. plugin-bundled alongside a project-pinned server) stays
  // MCP-only. Probe the whole retry window, since the first instance may
  // itself have been bumped off the configured port by a foreign occupant.
  // A different project's dashboard does NOT suppress startup — the port
  // retry below finds a free port as before.
  const resolvedRoot = path.resolve(projectRoot);
  if (config.port !== 0) {
    for (let p = config.port; p <= config.port + DASHBOARD_PORT_RETRIES; p++) {
      if (await isExistingDashboard(p, resolvedRoot)) {
        console.error(
          `[twining] Dashboard for this project already running on port ${p} — ` +
            `skipping dashboard in this instance (single-instance guard, #42)`,
        );
        return null;
      }
    }
  }

  // Resolve public/ directory relative to this compiled file
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, "public");

  const server = http.createServer(handleRequest(publicDir, projectRoot, deps));
  const port = await tryListen(server, config.port, DASHBOARD_PORT_RETRIES);

  const url = `http://127.0.0.1:${port}`;
  console.error(`[twining] Dashboard: ${url}`);

  // Auto-open browser (non-fatal on failure)
  if (config.autoOpen) {
    // If we bound to a different port than requested, check if another
    // dashboard instance is already running on the original port.
    // This prevents opening duplicate tabs when multiple MCP instances start.
    const resolvedRoot = path.resolve(projectRoot);
    const skipOpen =
      port !== config.port &&
      (await isExistingDashboard(config.port, resolvedRoot));
    if (skipOpen) {
      console.error(
        `[twining] Dashboard already running on port ${config.port}, skipping auto-open`,
      );
    } else {
      import("open")
        .then((mod) => mod.default(url))
        .catch(() => {
          // open package unavailable or browser launch failed — not critical
        });
    }
  }

  return { server, port };
}

/**
 * Register signal handlers for graceful dashboard shutdown.
 * Closes the HTTP server on SIGTERM/SIGINT with a 3-second force-exit timeout.
 */
export function setupDashboardShutdown(httpServer: http.Server): void {
  const shutdown = () => {
    httpServer.close(() => {
      // Server closed cleanly
    });
    // Force exit after 3 seconds if close hangs
    const timer = setTimeout(() => {
      process.exit(0);
    }, 3000);
    // Don't let the timer keep the process alive
    if (timer.unref) {
      timer.unref();
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
