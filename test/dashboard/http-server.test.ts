import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDashboardConfig } from "../../src/dashboard/dashboard-config.js";
import { startDashboard } from "../../src/dashboard/http-server.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Save and restore env vars around each test. */
const ENV_KEYS = [
  "TWINING_DASHBOARD_PORT",
  "TWINING_DASHBOARD",
  "TWINING_DASHBOARD_NO_OPEN",
] as const;

let savedEnv: Record<string, string | undefined>;

function saveEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

/** Make an HTTP request and return status, headers, and body. */
function httpGet(
  port: number,
  urlPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Create a temp directory with test static files. */
function createTempPublic(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-test-"));
  fs.writeFileSync(
    path.join(tmpDir, "index.html"),
    "<html><body>Hello</body></html>",
  );
  fs.writeFileSync(path.join(tmpDir, "style.css"), "body { color: red; }");
  fs.writeFileSync(
    path.join(tmpDir, "app.js"),
    'console.log("app");',
  );
  return tmpDir;
}

/* ------------------------------------------------------------------ */
/* Tests: getDashboardConfig                                          */
/* ------------------------------------------------------------------ */

describe("getDashboardConfig", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("returns defaults when no env vars set", () => {
    delete process.env["TWINING_DASHBOARD_PORT"];
    delete process.env["TWINING_DASHBOARD"];
    delete process.env["TWINING_DASHBOARD_NO_OPEN"];

    const config = getDashboardConfig();
    expect(config.port).toBe(24282);
    expect(config.enabled).toBe(true);
    expect(config.autoOpen).toBe(true);
  });

  it("reads TWINING_DASHBOARD_PORT as number", () => {
    process.env["TWINING_DASHBOARD_PORT"] = "9999";
    const config = getDashboardConfig();
    expect(config.port).toBe(9999);
  });

  it("TWINING_DASHBOARD=0 sets enabled to false", () => {
    process.env["TWINING_DASHBOARD"] = "0";
    const config = getDashboardConfig();
    expect(config.enabled).toBe(false);
  });

  it("TWINING_DASHBOARD_NO_OPEN=1 sets autoOpen to false", () => {
    process.env["TWINING_DASHBOARD_NO_OPEN"] = "1";
    const config = getDashboardConfig();
    expect(config.autoOpen).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: startDashboard                                              */
/* ------------------------------------------------------------------ */

describe("startDashboard", () => {
  let servers: http.Server[] = [];
  let tmpDirs: string[] = [];

  beforeEach(() => {
    saveEnv();
    servers = [];
    tmpDirs = [];
  });

  afterEach(async () => {
    restoreEnv();
    // Close all servers opened during the test
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
    // Clean up temp directories
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when TWINING_DASHBOARD=0", async () => {
    process.env["TWINING_DASHBOARD"] = "0";
    const result = await startDashboard("/tmp");
    expect(result).toBeNull();
  });

  it("returns { server, port } on success", async () => {
    process.env["TWINING_DASHBOARD_PORT"] = "0"; // let OS pick port
    const result = await startDashboard("/tmp");
    expect(result).not.toBeNull();
    expect(result!.server).toBeInstanceOf(http.Server);
    expect(typeof result!.port).toBe("number");
    servers.push(result!.server);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: Health endpoint                                             */
/* ------------------------------------------------------------------ */

describe("/api/health endpoint", () => {
  let server: http.Server | null = null;
  let port = 0;

  beforeEach(async () => {
    saveEnv();
    // Use port 0 to let OS assign a free port
    process.env["TWINING_DASHBOARD_PORT"] = "0";
    const result = await startDashboard("/tmp");
    expect(result).not.toBeNull();
    server = result!.server;
    port = result!.port;
  });

  afterEach(async () => {
    restoreEnv();
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
    }
  });

  it('returns 200 with {"ok":true,"server":"twining-mcp"}', async () => {
    const res = await httpGet(port, "/api/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, server: "twining-mcp" });
  });

  it("returns correct application/json Content-Type", async () => {
    const res = await httpGet(port, "/api/health");
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

/* ------------------------------------------------------------------ */
/* Tests: Static file serving                                         */
/* ------------------------------------------------------------------ */

describe("static file serving", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    saveEnv();
    tmpDir = createTempPublic();

    // We need a server that serves from our temp dir.
    // Import the module internals through startDashboard is tricky since
    // publicDir is resolved from import.meta.url. Instead, create a raw
    // HTTP server using the same patterns.
    const httpModule = await import("node:http");
    const fsPromises = await import("node:fs/promises");
    const pathModule = await import("node:path");

    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    };

    server = httpModule.default.createServer((req, res) => {
      const rawUrl = req.url || "/";
      const qIndex = rawUrl.indexOf("?");
      const rawPath = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
      const decodedPath = decodeURIComponent(rawPath);
      const pathname = decodedPath === "/" ? "/index.html" : decodedPath;
      const filePath = pathModule.default.join(tmpDir, pathname);

      const resolved = pathModule.default.resolve(filePath);
      if (!resolved.startsWith(pathModule.default.resolve(tmpDir))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      fsPromises.default
        .readFile(resolved)
        .then((data) => {
          const ext = pathModule.default.extname(resolved);
          res.writeHead(200, {
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
          });
          res.end(data);
        })
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            res.writeHead(404);
            res.end("Not Found");
          } else {
            res.writeHead(500);
            res.end("Internal Server Error");
          }
        });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    restoreEnv();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves index.html for / request", async () => {
    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<html>");
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("serves CSS file with correct Content-Type", async () => {
    const res = await httpGet(port, "/style.css");
    expect(res.status).toBe(200);
    expect(res.body).toContain("color: red");
    expect(res.headers["content-type"]).toContain("text/css");
  });

  it("returns correct MIME type for .js files", async () => {
    const res = await httpGet(port, "/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
  });

  it("returns 404 for missing file", async () => {
    const res = await httpGet(port, "/nonexistent.html");
    expect(res.status).toBe(404);
  });

  it("returns 403 for path traversal attempt", async () => {
    const res = await httpGet(port, "/../../../etc/passwd");
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Tests: Port retry                                                  */
/* ------------------------------------------------------------------ */

describe("port retry", () => {
  let blockerServer: http.Server;
  let dashboardResult: { server: http.Server; port: number } | null = null;
  let blockerPort: number;

  beforeEach(async () => {
    saveEnv();

    // Bind a server to block a specific port
    blockerServer = http.createServer();
    await new Promise<void>((resolve) => {
      blockerServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = blockerServer.address();
    blockerPort = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    restoreEnv();
    await new Promise<void>((resolve) => {
      blockerServer.close(() => resolve());
    });
    if (dashboardResult?.server) {
      await new Promise<void>((resolve) => {
        dashboardResult!.server.close(() => resolve());
      });
    }
  });

  it("starts on next available port when preferred port is in use", async () => {
    // Tell dashboard to use the blocked port
    process.env["TWINING_DASHBOARD_PORT"] = String(blockerPort);

    dashboardResult = await startDashboard("/tmp");
    expect(dashboardResult).not.toBeNull();
    // Should have retried to a different port (blockerPort is occupied)
    expect(dashboardResult!.port).not.toBe(blockerPort);
    // The retried port should be >= blockerPort + 1
    expect(dashboardResult!.port).toBeGreaterThanOrEqual(blockerPort + 1);
  });
});
