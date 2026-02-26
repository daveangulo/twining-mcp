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

  // Agent registry
  const agentsDir = path.join(twiningDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const agentRecords = [
    {
      agent_id: "agent-alpha",
      capabilities: ["typescript", "testing"],
      role: "developer",
      description: "Alpha agent",
      registered_at: "2026-02-17T08:00:00.000Z",
      last_active: new Date().toISOString(),
    },
    {
      agent_id: "agent-beta",
      capabilities: ["python", "data"],
      role: "analyst",
      description: "Beta agent",
      registered_at: "2026-02-17T09:00:00.000Z",
      last_active: "2025-01-01T00:00:00.000Z",
    },
  ];
  fs.writeFileSync(
    path.join(agentsDir, "registry.json"),
    JSON.stringify(agentRecords, null, 2),
  );

  // Handoff data
  const handoffsDir = path.join(twiningDir, "handoffs");
  fs.mkdirSync(handoffsDir, { recursive: true });
  const handoffRecord = {
    id: "HND001",
    created_at: "2026-02-17T10:00:00.000Z",
    source_agent: "agent-alpha",
    target_agent: "agent-beta",
    scope: "src/",
    summary: "Hand off testing work",
    results: [
      {
        description: "Write tests",
        status: "completed",
        notes: "All tests pass",
      },
    ],
    context_snapshot: {
      decision_ids: ["DEC001"],
      warning_ids: [],
      finding_ids: [],
      summaries: ["Use embedded HTTP server"],
    },
    acknowledged_by: null,
    acknowledged_at: null,
  };
  fs.writeFileSync(
    path.join(handoffsDir, "HND001.json"),
    JSON.stringify(handoffRecord, null, 2),
  );
  // Handoff index (JSONL)
  fs.writeFileSync(
    path.join(handoffsDir, "index.jsonl"),
    JSON.stringify({
      id: "HND001",
      created_at: "2026-02-17T10:00:00.000Z",
      source_agent: "agent-alpha",
      target_agent: "agent-beta",
      scope: "src/",
      summary: "Hand off testing work",
      result_status: "completed",
      acknowledged: false,
    }) + "\n",
  );

  // Add delegation entry to blackboard (BB004)
  fs.appendFileSync(
    path.join(twiningDir, "blackboard.jsonl"),
    JSON.stringify({
      id: "BB004",
      timestamp: "2026-02-17T13:00:00.000Z",
      agent_id: "agent-alpha",
      entry_type: "need",
      tags: ["delegation"],
      scope: "src/api/",
      summary: "Need typescript expert",
      detail: JSON.stringify({
        type: "delegation",
        required_capabilities: ["typescript"],
        urgency: "normal",
        expires_at: "2099-12-31T23:59:59.000Z",
      }),
    }) + "\n",
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
    expect(body.project_name).toBe(path.basename(projectRoot));
    expect(body.blackboard_entries).toBe(4);
    expect(body.active_decisions).toBe(1);
    expect(body.provisional_decisions).toBe(1);
    expect(body.graph_entities).toBe(2);
    expect(body.graph_relations).toBe(1);
    expect(body.last_activity).toBe("2026-02-17T13:00:00.000Z");
  });

  it("GET /api/blackboard returns entries array with total_count", async () => {
    const res = await httpGet(port, "/api/blackboard");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.entries).toHaveLength(4);
    expect(body.total_count).toBe(4);

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

  it("GET /api/agents returns agents with liveness", async () => {
    const res = await httpGet(port, "/api/agents");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.agents).toHaveLength(2);
    expect(body.total).toBe(2);

    // Each agent should have expected fields
    for (const agent of body.agents) {
      expect(agent).toHaveProperty("agent_id");
      expect(agent).toHaveProperty("capabilities");
      expect(agent).toHaveProperty("liveness");
    }

    // agent-alpha was just active, should be "active"
    const alpha = body.agents.find(
      (a: { agent_id: string }) => a.agent_id === "agent-alpha",
    );
    expect(alpha.liveness).toBe("active");

    // agent-beta has old last_active, should be "gone"
    const beta = body.agents.find(
      (a: { agent_id: string }) => a.agent_id === "agent-beta",
    );
    expect(beta.liveness).toBe("gone");
  });

  it("GET /api/delegations returns delegation needs with scored agents", async () => {
    const res = await httpGet(port, "/api/delegations");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.delegations.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBe(body.delegations.length);

    const delegation = body.delegations[0];
    expect(delegation).toHaveProperty("entry_id");
    expect(delegation).toHaveProperty("required_capabilities");
    expect(delegation).toHaveProperty("urgency");
    expect(delegation).toHaveProperty("expired");
    expect(delegation).toHaveProperty("suggested_agents");
    expect(Array.isArray(delegation.suggested_agents)).toBe(true);

    // Test delegation expires in 2099, so not expired
    expect(delegation.expired).toBe(false);
  });

  it("GET /api/handoffs returns handoff index entries", async () => {
    const res = await httpGet(port, "/api/handoffs");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.handoffs).toHaveLength(1);
    expect(body.total).toBe(1);

    const handoff = body.handoffs[0];
    expect(handoff).toHaveProperty("id");
    expect(handoff).toHaveProperty("source_agent");
    expect(handoff).toHaveProperty("target_agent");
    expect(handoff).toHaveProperty("result_status");
    expect(handoff).toHaveProperty("acknowledged");
  });

  it("GET /api/handoffs/:id returns full handoff record", async () => {
    const res = await httpGet(port, "/api/handoffs/HND001");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.id).toBe("HND001");
    expect(body.results).toBeInstanceOf(Array);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.context_snapshot).toHaveProperty("decision_ids");
    expect(body.context_snapshot.decision_ids).toContain("DEC001");
  });

  it("GET /api/handoffs/:id returns 404 for unknown ID", async () => {
    const res = await httpGet(port, "/api/handoffs/NONEXISTENT");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.error).toBe("Handoff not found");
  });

  it("GET /api/status includes coordination counts", async () => {
    const res = await httpGet(port, "/api/status");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.registered_agents).toBe(2);
    expect(body.active_agents).toBeGreaterThanOrEqual(1);
    expect(typeof body.pending_delegations).toBe("number");
    expect(body.total_handoffs).toBe(1);
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
    expect(body.project_name).toBe(path.basename(projectRoot));
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

  it("GET /api/search returns empty results for uninitialized project", async () => {
    const res = await httpGet(port, "/api/search?q=test");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.fallback_mode).toBe(true);
  });

  it("GET /api/agents returns initialized:false with empty agents", async () => {
    const res = await httpGet(port, "/api/agents");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(false);
    expect(body.agents).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET /api/delegations returns initialized:false with empty delegations", async () => {
    const res = await httpGet(port, "/api/delegations");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(false);
    expect(body.delegations).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET /api/handoffs returns initialized:false with empty handoffs", async () => {
    const res = await httpGet(port, "/api/handoffs");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(false);
    expect(body.handoffs).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET /api/handoffs/:id returns 404 when uninitialized", async () => {
    const res = await httpGet(port, "/api/handoffs/HND001");
    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    expect(body.error).toBe("Handoff not found");
  });

  it("GET /api/status includes zero coordination counts when uninitialized", async () => {
    const res = await httpGet(port, "/api/status");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.registered_agents).toBe(0);
    expect(body.active_agents).toBe(0);
    expect(body.pending_delegations).toBe(0);
    expect(body.total_handoffs).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: GET /api/search                                         */
/* ------------------------------------------------------------------ */

describe("GET /api/search", () => {
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

  it("returns empty results when no query param", async () => {
    const res = await httpGet(port, "/api/search");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.query).toBe("");
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns blackboard results for matching query", async () => {
    // "finding" matches BB001 summary "Test finding" and detail "A test finding..."
    const res = await httpGet(port, "/api/search?q=finding");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.query).toBe("finding");
    expect(body.total).toBeGreaterThan(0);

    const bbResults = body.results.filter(
      (r: { type: string }) => r.type === "blackboard",
    );
    expect(bbResults.length).toBeGreaterThan(0);
    expect(bbResults[0]).toHaveProperty("id");
    expect(bbResults[0]).toHaveProperty("summary");
    expect(bbResults[0]).toHaveProperty("entry_type");
    expect(bbResults[0]).toHaveProperty("relevance");
  });

  it("returns decision results for matching query", async () => {
    // "embedded HTTP server" matches DEC001 summary
    const res = await httpGet(port, "/api/search?q=embedded");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    const decResults = body.results.filter(
      (r: { type: string }) => r.type === "decision",
    );
    expect(decResults.length).toBeGreaterThan(0);
    expect(decResults[0]).toHaveProperty("id");
    expect(decResults[0]).toHaveProperty("summary");
    expect(decResults[0]).toHaveProperty("domain");
    expect(decResults[0]).toHaveProperty("status");
    expect(decResults[0]).toHaveProperty("relevance");
  });

  it("returns entity results for matching query", async () => {
    // "HttpServer" matches ENT001 name
    const res = await httpGet(port, "/api/search?q=HttpServer");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    const entResults = body.results.filter(
      (r: { type: string }) => r.type === "entity",
    );
    expect(entResults.length).toBeGreaterThan(0);
    expect(entResults[0]).toHaveProperty("name");
    expect(entResults[0]).toHaveProperty("entity_type");
    expect(entResults[0].relevance).toBe(0.5);
  });

  it("filters by types param — blackboard only", async () => {
    const res = await httpGet(port, "/api/search?q=API&types=blackboard");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    // Every result should be blackboard type
    for (const r of body.results) {
      expect(r.type).toBe("blackboard");
    }
    // Should not contain decision or entity results
    const nonBB = body.results.filter(
      (r: { type: string }) => r.type !== "blackboard",
    );
    expect(nonBB).toHaveLength(0);
  });

  it("includes fallback_mode in response", async () => {
    const res = await httpGet(port, "/api/search?q=test");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(typeof body.fallback_mode).toBe("boolean");
  });

  it("filters by scope prefix", async () => {
    // scope=src/dashboard/ should only return items scoped under src/dashboard/
    const res = await httpGet(
      port,
      "/api/search?q=API&scope=src/dashboard/",
    );
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    // All blackboard and decision results should have scope starting with src/dashboard/
    for (const r of body.results) {
      if (r.scope) {
        expect(r.scope.startsWith("src/dashboard/")).toBe(true);
      }
    }
  });

  it("filters by status param for decisions", async () => {
    // status=active should only return active decisions
    const res = await httpGet(
      port,
      "/api/search?q=server&status=active",
    );
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    const decResults = body.results.filter(
      (r: { type: string }) => r.type === "decision",
    );
    for (const r of decResults) {
      expect(r.status).toBe("active");
    }
  });

  it("results are sorted by relevance descending", async () => {
    // Use a broad query that hits multiple types
    const res = await httpGet(port, "/api/search?q=API");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    if (body.results.length > 1) {
      for (let i = 0; i < body.results.length - 1; i++) {
        expect(body.results[i].relevance).toBeGreaterThanOrEqual(
          body.results[i + 1].relevance,
        );
      }
    }
  });

  it("returns correct response structure", async () => {
    const res = await httpGet(port, "/api/search?q=dashboard");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("query");
    expect(body).toHaveProperty("results");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("fallback_mode");
    expect(typeof body.query).toBe("string");
    expect(Array.isArray(body.results)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(body.results.length);
  });
});
