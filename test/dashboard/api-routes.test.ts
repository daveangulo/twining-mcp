import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleRequest } from "../../src/dashboard/http-server.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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

/** Create a temp project with .twining/ data for testing. */
function createTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-api-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const decisionsDir = path.join(twiningDir, "decisions");
  const graphDir = path.join(twiningDir, "graph");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  // Write index.html for static file fallback test
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  // Blackboard entries (JSONL format)
  const bbEntries = [
    {
      id: "BB001",
      timestamp: "2026-02-17T10:00:00.000Z",
      agent_id: "test-agent",
      entry_type: "finding",
      tags: ["test"],
      scope: "src/",
      summary: "Test finding",
      detail: "A test finding for API tests",
    },
    {
      id: "BB002",
      timestamp: "2026-02-17T11:00:00.000Z",
      agent_id: "test-agent",
      entry_type: "need",
      tags: ["api"],
      scope: "src/dashboard/",
      summary: "Need API endpoints",
      detail: "Dashboard needs data API endpoints",
    },
    {
      id: "BB003",
      timestamp: "2026-02-17T12:00:00.000Z",
      agent_id: "test-agent",
      entry_type: "status",
      tags: ["progress"],
      scope: "src/dashboard/",
      summary: "API routes created",
      detail: "All 5 API endpoints are implemented",
    },
  ];
  fs.writeFileSync(
    path.join(twiningDir, "blackboard.jsonl"),
    bbEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  // Decision index (JSON array) and individual decision files
  const decision1 = {
    id: "DEC001",
    timestamp: "2026-02-17T09:00:00.000Z",
    agent_id: "test-agent",
    domain: "architecture",
    scope: "src/dashboard/",
    summary: "Use embedded HTTP server",
    context: "Need a dashboard for observability",
    rationale: "Keeps things simple without external deps",
    constraints: ["no external frameworks"],
    alternatives: [
      {
        option: "Express.js",
        pros: ["mature", "well-documented"],
        cons: ["extra dependency"],
        reason_rejected: "Unnecessary complexity",
      },
    ],
    depends_on: [],
    confidence: "high",
    status: "active",
    reversible: true,
    affected_files: ["src/dashboard/http-server.ts"],
    affected_symbols: ["startDashboard"],
    commit_hashes: [],
  };
  const decision2 = {
    id: "DEC002",
    timestamp: "2026-02-17T10:30:00.000Z",
    agent_id: "test-agent",
    domain: "api",
    scope: "src/dashboard/api-routes.ts",
    summary: "JSON-only API responses",
    context: "Dashboard needs data endpoints",
    rationale: "Simple and consistent",
    constraints: [],
    alternatives: [],
    depends_on: ["DEC001"],
    confidence: "high",
    status: "provisional",
    reversible: true,
    affected_files: ["src/dashboard/api-routes.ts"],
    affected_symbols: ["createApiHandler"],
    commit_hashes: ["abc1234"],
  };

  const indexEntries = [
    {
      id: "DEC001",
      timestamp: "2026-02-17T09:00:00.000Z",
      domain: "architecture",
      scope: "src/dashboard/",
      summary: "Use embedded HTTP server",
      confidence: "high",
      status: "active",
      affected_files: ["src/dashboard/http-server.ts"],
      affected_symbols: ["startDashboard"],
      commit_hashes: [],
    },
    {
      id: "DEC002",
      timestamp: "2026-02-17T10:30:00.000Z",
      domain: "api",
      scope: "src/dashboard/api-routes.ts",
      summary: "JSON-only API responses",
      confidence: "high",
      status: "provisional",
      affected_files: ["src/dashboard/api-routes.ts"],
      affected_symbols: ["createApiHandler"],
      commit_hashes: ["abc1234"],
    },
  ];

  fs.writeFileSync(
    path.join(decisionsDir, "index.json"),
    JSON.stringify(indexEntries, null, 2),
  );
  fs.writeFileSync(
    path.join(decisionsDir, "DEC001.json"),
    JSON.stringify(decision1, null, 2),
  );
  fs.writeFileSync(
    path.join(decisionsDir, "DEC002.json"),
    JSON.stringify(decision2, null, 2),
  );

  // Graph data (JSON arrays)
  const entities = [
    {
      id: "ENT001",
      name: "HttpServer",
      type: "module",
      properties: { file: "src/dashboard/http-server.ts" },
      created_at: "2026-02-17T08:00:00.000Z",
      updated_at: "2026-02-17T08:00:00.000Z",
    },
    {
      id: "ENT002",
      name: "ApiRoutes",
      type: "module",
      properties: { file: "src/dashboard/api-routes.ts" },
      created_at: "2026-02-17T09:00:00.000Z",
      updated_at: "2026-02-17T09:00:00.000Z",
    },
  ];
  const relations = [
    {
      id: "REL001",
      source: "ENT001",
      target: "ENT002",
      type: "imports",
      properties: {},
      created_at: "2026-02-17T09:00:00.000Z",
    },
  ];
  fs.writeFileSync(
    path.join(graphDir, "entities.json"),
    JSON.stringify(entities, null, 2),
  );
  fs.writeFileSync(
    path.join(graphDir, "relations.json"),
    JSON.stringify(relations, null, 2),
  );

  return { projectRoot, publicDir };
}

/* ------------------------------------------------------------------ */
/* Test suite: initialized project (with .twining/ data)              */
/* ------------------------------------------------------------------ */

describe("API routes - initialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createTestProject();
    projectRoot = project.projectRoot;

    server = http.createServer(
      handleRequest(project.publicDir, project.projectRoot),
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("GET /api/status returns all expected fields with correct counts", async () => {
    const res = await httpGet(port, "/api/status");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toBe("no-cache");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.blackboard_entries).toBe(3);
    expect(body.active_decisions).toBe(1);
    expect(body.provisional_decisions).toBe(1);
    expect(body.graph_entities).toBe(2);
    expect(body.graph_relations).toBe(1);
    expect(body.last_activity).toBe("2026-02-17T12:00:00.000Z");
  });

  it("GET /api/blackboard returns entries array with total_count", async () => {
    const res = await httpGet(port, "/api/blackboard");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.entries).toHaveLength(3);
    expect(body.total_count).toBe(3);

    // Verify entry structure
    const entry = body.entries[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("summary");
    expect(entry).toHaveProperty("entry_type");
  });

  it("GET /api/decisions returns index entries (not full decisions)", async () => {
    const res = await httpGet(port, "/api/decisions");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.decisions).toHaveLength(2);
    expect(body.total_count).toBe(2);

    // Index entries should have id, summary, status but NOT rationale, alternatives, context
    const decision = body.decisions[0];
    expect(decision).toHaveProperty("id");
    expect(decision).toHaveProperty("summary");
    expect(decision).toHaveProperty("status");
    expect(decision).not.toHaveProperty("rationale");
    expect(decision).not.toHaveProperty("alternatives");
    expect(decision).not.toHaveProperty("context");
  });

  it("GET /api/decisions/:id returns full decision with rationale and alternatives", async () => {
    const res = await httpGet(port, "/api/decisions/DEC001");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.id).toBe("DEC001");
    expect(body.summary).toBe("Use embedded HTTP server");
    expect(body.rationale).toBe("Keeps things simple without external deps");
    expect(body.alternatives).toHaveLength(1);
    expect(body.alternatives[0].option).toBe("Express.js");
    expect(body.context).toBe("Need a dashboard for observability");
  });

  it("GET /api/decisions/:id returns 404 for unknown ID", async () => {
    const res = await httpGet(port, "/api/decisions/NONEXISTENT");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.error).toBe("Decision not found");
  });

  it("GET /api/graph returns entities and relations with counts", async () => {
    const res = await httpGet(port, "/api/graph");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.entities).toHaveLength(2);
    expect(body.relations).toHaveLength(1);
    expect(body.entity_count).toBe(2);
    expect(body.relation_count).toBe(1);

    // Verify entity structure
    expect(body.entities[0]).toHaveProperty("id");
    expect(body.entities[0]).toHaveProperty("name");
    expect(body.entities[0]).toHaveProperty("type");

    // Verify relation structure
    expect(body.relations[0]).toHaveProperty("source");
    expect(body.relations[0]).toHaveProperty("target");
    expect(body.relations[0]).toHaveProperty("type");
  });

  it("GET /api/health still works (falls through from API handler)", async () => {
    const res = await httpGet(port, "/api/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, server: "twining-mcp" });
  });

  it("unknown route falls through to static file serving", async () => {
    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Dashboard");
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: uninitialized project (no .twining/ directory)         */
/* ------------------------------------------------------------------ */

describe("API routes - uninitialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;
  let publicDir: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-api-uninit-"),
    );
    publicDir = path.join(projectRoot, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, "index.html"),
      "<html><body>Empty</body></html>",
    );

    // No .twining/ directory created

    server = http.createServer(handleRequest(publicDir, projectRoot));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("GET /api/status returns initialized:false with zeros", async () => {
    const res = await httpGet(port, "/api/status");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(false);
    expect(body.blackboard_entries).toBe(0);
    expect(body.active_decisions).toBe(0);
    expect(body.provisional_decisions).toBe(0);
    expect(body.graph_entities).toBe(0);
    expect(body.graph_relations).toBe(0);
    expect(body.last_activity).toBe("none");
  });

  it("GET /api/blackboard returns initialized:false with empty entries", async () => {
    const res = await httpGet(port, "/api/blackboard");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(false);
    expect(body.entries).toEqual([]);
    expect(body.total_count).toBe(0);
  });

  it("GET /api/decisions returns initialized:false with empty array", async () => {
    const res = await httpGet(port, "/api/decisions");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(false);
    expect(body.decisions).toEqual([]);
    expect(body.total_count).toBe(0);
  });

  it("GET /api/decisions/:id returns 404 when uninitialized", async () => {
    const res = await httpGet(port, "/api/decisions/DEC001");
    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    expect(body.error).toBe("Decision not found");
  });

  it("GET /api/graph returns initialized:false with empty arrays", async () => {
    const res = await httpGet(port, "/api/graph");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(false);
    expect(body.entities).toEqual([]);
    expect(body.relations).toEqual([]);
    expect(body.entity_count).toBe(0);
    expect(body.relation_count).toBe(0);
  });
});
