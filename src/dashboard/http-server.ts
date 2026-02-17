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
 */
function handleRequest(
  publicDir: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const staticHandler = serveStatic(publicDir);

  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, server: "twining-mcp" }));
      return;
    }

    staticHandler(req, res).catch((err: unknown) => {
      console.error("[twining] Static file handler error:", err);
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
 * @param _projectRoot - The project root directory (reserved for future use)
 */
export async function startDashboard(
  _projectRoot: string,
): Promise<{ server: http.Server; port: number } | null> {
  const config = getDashboardConfig();
  if (!config.enabled) {
    return null;
  }

  // Resolve public/ directory relative to this compiled file
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, "public");

  const server = http.createServer(handleRequest(publicDir));
  const port = await tryListen(server, config.port, 5);

  const url = `http://127.0.0.1:${port}`;
  console.error(`[twining] Dashboard: ${url}`);

  // Auto-open browser (non-fatal on failure)
  if (config.autoOpen) {
    import("open")
      .then((mod) => mod.default(url))
      .catch(() => {
        // open package unavailable or browser launch failed — not critical
      });
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
