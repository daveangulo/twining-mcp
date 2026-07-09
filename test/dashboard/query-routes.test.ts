import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { handleRequest } from "../../src/dashboard/http-server.js";

/* ------------------------------------------------------------------ */
/* Helpers (copied pattern from test/dashboard/api-routes.test.ts)    */
/* ------------------------------------------------------------------ */

/** Make an HTTP request and return status, headers, and raw body buffer. */
function httpGet(
  port: number,
  urlPath: string,
  headers?: http.OutgoingHttpHeaders,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const LONG_SUMMARY = "x".repeat(150);
const TRUNCATED_SUMMARY = "x".repeat(119) + "…";

/** Create a temp project with .twining/ blackboard + decisions data for testing. */
function createTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-query-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const decisionsDir = path.join(twiningDir, "decisions");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  // Blackboard entries (JSONL). BB002 has a >120-char summary to test truncation.
  const bbEntries = [
    {
      id: "BB001",
      timestamp: "2026-02-17T08:00:00.000Z",
      agent_id: "test-agent",
      entry_type: "finding",
      tags: ["a"],
      scope: "src/",
      summary: "Short summary one",
      detail: "detail one",
    },
    {
      id: "BB002",
      timestamp: "2026-02-17T12:00:00.000Z",
      agent_id: "test-agent",
      entry_type: "need",
      tags: ["b"],
      scope: "src/dashboard/",
      summary: LONG_SUMMARY,
      detail: "detail two",
    },
  ];
  fs.writeFileSync(
    path.join(twiningDir, "blackboard.jsonl"),
    bbEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  // Decision index — 2 active, 1 superseded (per brief fixture requirement).
  const indexEntries = [
    {
      id: "DEC001",
      timestamp: "2026-02-17T09:00:00.000Z",
      domain: "architecture",
      scope: "src/",
      summary: "Decision one",
      confidence: "high",
      status: "active",
      affected_files: [],
      affected_symbols: [],
      commit_hashes: [],
    },
    {
      id: "DEC002",
      timestamp: "2026-02-17T10:00:00.000Z",
      domain: "api",
      scope: "src/dashboard/",
      summary: "Decision two",
      confidence: "medium",
      status: "active",
      affected_files: [],
      affected_symbols: [],
      commit_hashes: [],
    },
    {
      id: "DEC003",
      timestamp: "2026-02-17T11:00:00.000Z",
      domain: "api",
      scope: "src/dashboard/",
      summary: "Decision three",
      confidence: "low",
      status: "superseded",
      affected_files: [],
      affected_symbols: [],
      commit_hashes: [],
    },
  ];
  fs.writeFileSync(
    path.join(decisionsDir, "index.json"),
    JSON.stringify(indexEntries, null, 2),
  );

  return { projectRoot, publicDir };
}

/** Create a temp project with enough blackboard entries to push /api/index past the 8KB gzip threshold. */
function createLargeTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-query-gzip-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const decisionsDir = path.join(twiningDir, "decisions");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  const bbEntries = [];
  for (let i = 0; i < 80; i++) {
    const hh = String(8 + Math.floor(i / 60)).padStart(2, "0");
    const mm = String(i % 60).padStart(2, "0");
    bbEntries.push({
      id: `BB${String(i).padStart(3, "0")}`,
      timestamp: `2026-02-17T${hh}:${mm}:00.000Z`,
      agent_id: "test-agent",
      entry_type: "finding",
      tags: ["gzip-test"],
      scope: "src/",
      summary: `Padding entry number ${i} to exceed the gzip response threshold with some extra filler text`,
      detail: "detail",
    });
  }
  fs.writeFileSync(
    path.join(twiningDir, "blackboard.jsonl"),
    bbEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  fs.writeFileSync(path.join(decisionsDir, "index.json"), JSON.stringify([]));

  return { projectRoot, publicDir };
}

/**
 * Create a temp project with .twining/graph/{entities,relations}.json for
 * /api/graph/summary + /api/graph/entities testing.
 *
 * 6 entities across 3 types, 5 relations, 1 orphan entity (E6/orphan.ts).
 * Degrees: alpha.ts=3, zulu=3, yankee=2, bravo.ts=1, mike=1, orphan.ts=0.
 */
function createGraphTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-query-graph-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const graphDir = path.join(twiningDir, "graph");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  const entities = [
    { id: "E1", name: "alpha.ts", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E2", name: "bravo.ts", type: "file", properties: {}, created_at: "2026-02-17T08:01:00.000Z", updated_at: "2026-02-17T08:01:00.000Z" },
    { id: "E3", name: "zulu", type: "function", properties: {}, created_at: "2026-02-17T08:02:00.000Z", updated_at: "2026-02-17T08:02:00.000Z" },
    { id: "E4", name: "yankee", type: "function", properties: {}, created_at: "2026-02-17T08:03:00.000Z", updated_at: "2026-02-17T08:03:00.000Z" },
    { id: "E5", name: "mike", type: "class", properties: {}, created_at: "2026-02-17T08:04:00.000Z", updated_at: "2026-02-17T08:04:00.000Z" },
    { id: "E6", name: "orphan.ts", type: "file", properties: {}, created_at: "2026-02-17T08:05:00.000Z", updated_at: "2026-02-17T08:05:00.000Z" },
  ];
  const relations = [
    { id: "R1", source: "E1", target: "E3", type: "contains", properties: {}, created_at: "2026-02-17T09:00:00.000Z" },
    { id: "R2", source: "E1", target: "E4", type: "contains", properties: {}, created_at: "2026-02-17T09:01:00.000Z" },
    { id: "R3", source: "E2", target: "E3", type: "contains", properties: {}, created_at: "2026-02-17T09:02:00.000Z" },
    { id: "R4", source: "E3", target: "E4", type: "calls", properties: {}, created_at: "2026-02-17T09:03:00.000Z" },
    { id: "R5", source: "E1", target: "E5", type: "imports", properties: {}, created_at: "2026-02-17T09:04:00.000Z" },
  ];
  fs.writeFileSync(path.join(graphDir, "entities.json"), JSON.stringify(entities, null, 2));
  fs.writeFileSync(path.join(graphDir, "relations.json"), JSON.stringify(relations, null, 2));

  return { projectRoot, publicDir };
}

/* ------------------------------------------------------------------ */
/* Test suite: initialized project                                    */
/* ------------------------------------------------------------------ */

describe("GET /api/index - initialized project", () => {
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

  it("returns rows for every blackboard entry and decision, sorted timestamp ascending, with correct kinds and truncated summaries", async () => {
    const res = await httpGet(port, "/api/index");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.initialized).toBe(true);
    expect(body.rows).toHaveLength(5);

    // Sorted ascending: BB001(08:00) DEC001(09:00) DEC002(10:00) DEC003(11:00) BB002(12:00)
    const ids = body.rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(["BB001", "DEC001", "DEC002", "DEC003", "BB002"]);

    const timestamps = body.rows.map((r: { timestamp: string }) => r.timestamp);
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);

    const bb001 = body.rows.find((r: { id: string }) => r.id === "BB001");
    expect(bb001.kind).toBe("blackboard");
    expect(bb001.entry_type).toBe("finding");
    expect(bb001).not.toHaveProperty("status");
    expect(bb001.summary).toBe("Short summary one");

    const bb002 = body.rows.find((r: { id: string }) => r.id === "BB002");
    expect(bb002.kind).toBe("blackboard");
    expect(bb002.summary).toBe(TRUNCATED_SUMMARY);
    expect(bb002.summary.length).toBe(120);

    const dec001 = body.rows.find((r: { id: string }) => r.id === "DEC001");
    expect(dec001.kind).toBe("decision");
    expect(dec001.status).toBe("active");
    expect(dec001.domain).toBe("architecture");
    expect(dec001.confidence).toBe("high");
    expect(dec001).not.toHaveProperty("entry_type");
  });

  it("?since=<ts> returns only strictly-newer rows, but total_counts still reflects the full store", async () => {
    const res = await httpGet(
      port,
      "/api/index?since=2026-02-17T10:00:00.000Z",
    );
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    const ids = body.rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(["DEC003", "BB002"]);

    expect(body.total_counts.blackboard).toBe(2);
    expect(body.total_counts.decisions).toEqual({
      active: 2,
      provisional: 0,
      superseded: 1,
      overridden: 0,
    });
  });

  it("total_counts.decisions is broken down by status", async () => {
    const res = await httpGet(port, "/api/index");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.total_counts.decisions).toEqual({
      active: 2,
      provisional: 0,
      superseded: 1,
      overridden: 0,
    });
    expect(body.total_counts.blackboard).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: gzip                                                    */
/* ------------------------------------------------------------------ */

describe("GET /api/index - gzip", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createLargeTestProject();
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

  it("gzips the response when Accept-Encoding: gzip is sent and body is large", async () => {
    const res = await httpGet(port, "/api/index", { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");

    const decompressed = zlib.gunzipSync(res.body).toString("utf-8");
    const body = JSON.parse(decompressed);
    expect(body.initialized).toBe(true);
    expect(body.total_counts.blackboard).toBe(80);
    expect(body.rows).toHaveLength(80);
  });

  it("does not gzip when Accept-Encoding is not sent", async () => {
    const res = await httpGet(port, "/api/index");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.total_counts.blackboard).toBe(80);
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: uninitialized project (no .twining/ directory)         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Test suite: GET /api/blackboard/:id                                 */
/* ------------------------------------------------------------------ */

describe("GET /api/blackboard/:id", () => {
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

  it("returns the full blackboard entry including detail for an existing id", async () => {
    const res = await httpGet(port, "/api/blackboard/BB001");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.id).toBe("BB001");
    expect(body.detail).toBe("detail one");
    expect(body.summary).toBe("Short summary one");
    expect(body.entry_type).toBe("finding");
    expect(body.tags).toEqual(["a"]);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await httpGet(port, "/api/blackboard/NOPE999");
    expect(res.status).toBe(404);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when the id segment is empty", async () => {
    const res = await httpGet(port, "/api/blackboard/");
    expect(res.status).toBe(400);
  });

  it("does not intercept the legacy exact-match /api/blackboard route", async () => {
    const res = await httpGet(port, "/api/blackboard");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body).toHaveProperty("entries");
    expect(body).toHaveProperty("total_count");
    expect(body.entries).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: GET /api/blackboard/:id - uninitialized project         */
/* ------------------------------------------------------------------ */

describe("GET /api/blackboard/:id - uninitialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-query-bbdetail-uninit-"),
    );
    const publicDir = path.join(projectRoot, "public");
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

  it("returns 404 when .twining/ does not exist", async () => {
    const res = await httpGet(port, "/api/blackboard/BB001");
    expect(res.status).toBe(404);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.error).toBeTruthy();
  });
});

describe("GET /api/index - uninitialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-query-uninit-"),
    );
    const publicDir = path.join(projectRoot, "public");
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

  it("returns initialized:false with empty rows and zeroed counts", async () => {
    const res = await httpGet(port, "/api/index");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.initialized).toBe(false);
    expect(body.rows).toEqual([]);
    expect(body.total_counts).toEqual({
      blackboard: 0,
      decisions: { active: 0, provisional: 0, superseded: 0, overridden: 0 },
    });
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: GET /api/graph/summary                                 */
/* ------------------------------------------------------------------ */

describe("GET /api/graph/summary", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createGraphTestProject();
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

  it("returns groups with correct per-type counts", async () => {
    const res = await httpGet(port, "/api/graph/summary");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.initialized).toBe(true);

    const groupsByType: Record<string, number> = {};
    for (const g of body.groups) groupsByType[g.type] = g.count;
    expect(groupsByType).toEqual({ file: 3, function: 2, class: 1 });
  });

  it("aggregates group_edges by unordered type-pair with per-relation-type counts", async () => {
    const res = await httpGet(port, "/api/graph/summary");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.group_edges).toHaveLength(3);

    const fileFunction = body.group_edges.find(
      (e: { source_type: string; target_type: string }) =>
        e.source_type === "file" && e.target_type === "function",
    );
    expect(fileFunction).toBeDefined();
    expect(fileFunction.relation_counts).toEqual({ contains: 3 });
    expect(fileFunction.total).toBe(3);

    const functionFunction = body.group_edges.find(
      (e: { source_type: string; target_type: string }) =>
        e.source_type === "function" && e.target_type === "function",
    );
    expect(functionFunction).toBeDefined();
    expect(functionFunction.relation_counts).toEqual({ calls: 1 });
    expect(functionFunction.total).toBe(1);

    // class + file pair: sorted alphabetically -> class, file (regardless of
    // actual relation direction, which is file(E1) -> class(E5) here).
    const classFile = body.group_edges.find(
      (e: { source_type: string; target_type: string }) =>
        e.source_type === "class" && e.target_type === "file",
    );
    expect(classFile).toBeDefined();
    expect(classFile.relation_counts).toEqual({ imports: 1 });
    expect(classFile.total).toBe(1);
  });

  it("sorts hubs by degree desc, ties broken by name asc, top 20", async () => {
    const res = await httpGet(port, "/api/graph/summary");
    const body = JSON.parse(res.body.toString("utf-8"));

    const names = body.hubs.map((h: { name: string }) => h.name);
    expect(names).toEqual(["alpha.ts", "zulu", "yankee", "bravo.ts", "mike", "orphan.ts"]);

    const degrees = body.hubs.map((h: { degree: number }) => h.degree);
    expect(degrees).toEqual([3, 3, 2, 1, 1, 0]);
  });

  it("computes orphan_count, entity_count, relation_count", async () => {
    const res = await httpGet(port, "/api/graph/summary");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.orphan_count).toBe(1);
    expect(body.entity_count).toBe(6);
    expect(body.relation_count).toBe(5);
  });
});

describe("GET /api/graph/summary - uninitialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-query-graphsummary-uninit-"),
    );
    const publicDir = path.join(projectRoot, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, "index.html"),
      "<html><body>Empty</body></html>",
    );

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

  it("returns initialized:false with empty groups/hubs and zeroed counts", async () => {
    const res = await httpGet(port, "/api/graph/summary");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.initialized).toBe(false);
    expect(body.groups).toEqual([]);
    expect(body.group_edges).toEqual([]);
    expect(body.hubs).toEqual([]);
    expect(body.orphan_count).toBe(0);
    expect(body.entity_count).toBe(0);
    expect(body.relation_count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: GET /api/graph/entities                                */
/* ------------------------------------------------------------------ */

describe("GET /api/graph/entities", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createGraphTestProject();
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

  it("defaults to offset 0, limit 50, sorted degree desc then name asc", async () => {
    const res = await httpGet(port, "/api/graph/entities");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.total).toBe(6);
    expect(body.offset).toBe(0);

    const names = body.entities.map((e: { name: string }) => e.name);
    expect(names).toEqual(["alpha.ts", "zulu", "yankee", "bravo.ts", "mike", "orphan.ts"]);
    expect(body.entities[0]).toHaveProperty("id");
    expect(body.entities[0]).toHaveProperty("type");
    expect(body.entities[0]).toHaveProperty("degree");
  });

  it("filters by type", async () => {
    const res = await httpGet(port, "/api/graph/entities?type=file");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.total).toBe(3);
    const names = body.entities.map((e: { name: string }) => e.name);
    expect(names).toEqual(["alpha.ts", "bravo.ts", "orphan.ts"]);
  });

  it("filters by case-insensitive name substring q", async () => {
    const res = await httpGet(port, "/api/graph/entities?q=ZUL");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.total).toBe(1);
    expect(body.entities[0].name).toBe("zulu");
  });

  it("paginates with offset/limit; total reflects filtered count pre-paging", async () => {
    const res = await httpGet(port, "/api/graph/entities?offset=2&limit=2");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.total).toBe(6);
    expect(body.offset).toBe(2);
    const names = body.entities.map((e: { name: string }) => e.name);
    expect(names).toEqual(["yankee", "bravo.ts"]);
  });
});

describe("GET /api/graph/entities - uninitialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-query-graphentities-uninit-"),
    );
    const publicDir = path.join(projectRoot, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, "index.html"),
      "<html><body>Empty</body></html>",
    );

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

  it("returns empty entities with total 0", async () => {
    const res = await httpGet(port, "/api/graph/entities");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.entities).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.offset).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: GET /api/graph/neighborhood                            */
/* ------------------------------------------------------------------ */

/**
 * Star fixture: anchor A1 ("root") with 30 direct neighbors split evenly
 * across two entity types — 15 "file" (file01..file15) and 15 "function"
 * (fn01..fn15). Each neighbor has exactly one relation (to the anchor), so
 * every neighbor has degree=1 and ties are broken purely by name asc.
 * Anchor degree=30.
 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function createStarTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-query-star-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const graphDir = path.join(twiningDir, "graph");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  const entities: Array<{ id: string; name: string; type: string; properties: Record<string, unknown>; created_at: string; updated_at: string }> = [
    { id: "A1", name: "root", type: "module", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
  ];
  const relations: Array<{ id: string; source: string; target: string; type: string; properties: Record<string, unknown>; created_at: string }> = [];

  for (let i = 1; i <= 15; i++) {
    entities.push({ id: `F${i}`, name: `file${pad2(i)}`, type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" });
    relations.push({ id: `RF${i}`, source: "A1", target: `F${i}`, type: "related_to", properties: {}, created_at: "2026-02-17T09:00:00.000Z" });
  }
  for (let i = 1; i <= 15; i++) {
    entities.push({ id: `N${i}`, name: `fn${pad2(i)}`, type: "function", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" });
    relations.push({ id: `RN${i}`, source: "A1", target: `N${i}`, type: "related_to", properties: {}, created_at: "2026-02-17T09:00:00.000Z" });
  }

  fs.writeFileSync(path.join(graphDir, "entities.json"), JSON.stringify(entities, null, 2));
  fs.writeFileSync(path.join(graphDir, "relations.json"), JSON.stringify(relations, null, 2));

  return { projectRoot, publicDir };
}

/**
 * Second-ring fixture for depth=2 tests.
 * A1 (anchor) -> E2 (file, becomes degree 3: A1-E2, E2-E5, E2-E6)
 *             -> E3 (file, degree 2: A1-E3, E3-E7)
 * E2 -> E5 (file, leaf), E2 -> E6 (file, leaf)
 * E3 -> E7 (file, leaf)
 */
function createSecondRingTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-query-ring2-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const graphDir = path.join(twiningDir, "graph");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  const entities = [
    { id: "A1", name: "root", type: "module", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E2", name: "e2", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E3", name: "e3", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E5", name: "e5", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E6", name: "e6", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E7", name: "e7", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
  ];
  const relations = [
    { id: "R1", source: "A1", target: "E2", type: "related_to", properties: {}, created_at: "2026-02-17T09:00:00.000Z" },
    { id: "R2", source: "A1", target: "E3", type: "related_to", properties: {}, created_at: "2026-02-17T09:01:00.000Z" },
    { id: "R3", source: "E2", target: "E5", type: "related_to", properties: {}, created_at: "2026-02-17T09:02:00.000Z" },
    { id: "R4", source: "E2", target: "E6", type: "related_to", properties: {}, created_at: "2026-02-17T09:03:00.000Z" },
    { id: "R5", source: "E3", target: "E7", type: "related_to", properties: {}, created_at: "2026-02-17T09:04:00.000Z" },
  ];
  fs.writeFileSync(path.join(graphDir, "entities.json"), JSON.stringify(entities, null, 2));
  fs.writeFileSync(path.join(graphDir, "relations.json"), JSON.stringify(relations, null, 2));

  return { projectRoot, publicDir };
}

/**
 * Second-ring fixture with a MIXED-type cut: A1 (anchor) -> E2 (file, degree
 * 6: A1-E2 plus 5 children) and E3 (file, degree 2: A1-E3, E3-E7, leaf,
 * unused by the depth-2 walk once budget is exhausted on E2).
 * E2's children, sorted (degree desc [all =1], name asc): m1(file), m2
 * (function), m3(file), m4(file), m5(function) — deliberately interleaved
 * so a 2-item budget cut lands mid-type-group on both sides.
 */
function createSecondRingMixedTypeTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-query-ring2-mixed-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const graphDir = path.join(twiningDir, "graph");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  const entities = [
    { id: "A1", name: "root", type: "module", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E2", name: "e2", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E3", name: "e3", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "E7", name: "e7", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "M1", name: "m1", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "M2", name: "m2", type: "function", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "M3", name: "m3", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "M4", name: "m4", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "M5", name: "m5", type: "function", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
  ];
  const relations = [
    { id: "R1", source: "A1", target: "E2", type: "related_to", properties: {}, created_at: "2026-02-17T09:00:00.000Z" },
    { id: "R2", source: "A1", target: "E3", type: "related_to", properties: {}, created_at: "2026-02-17T09:01:00.000Z" },
    { id: "R3", source: "E3", target: "E7", type: "related_to", properties: {}, created_at: "2026-02-17T09:02:00.000Z" },
    { id: "R4", source: "E2", target: "M1", type: "related_to", properties: {}, created_at: "2026-02-17T09:03:00.000Z" },
    { id: "R5", source: "E2", target: "M2", type: "related_to", properties: {}, created_at: "2026-02-17T09:04:00.000Z" },
    { id: "R6", source: "E2", target: "M3", type: "related_to", properties: {}, created_at: "2026-02-17T09:05:00.000Z" },
    { id: "R7", source: "E2", target: "M4", type: "related_to", properties: {}, created_at: "2026-02-17T09:06:00.000Z" },
    { id: "R8", source: "E2", target: "M5", type: "related_to", properties: {}, created_at: "2026-02-17T09:07:00.000Z" },
  ];
  fs.writeFileSync(path.join(graphDir, "entities.json"), JSON.stringify(entities, null, 2));
  fs.writeFileSync(path.join(graphDir, "relations.json"), JSON.stringify(relations, null, 2));

  return { projectRoot, publicDir };
}

describe("GET /api/graph/neighborhood - depth=1 round-robin + overflow", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createStarTestProject();
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

  it("round-robins across the two type groups (5 file + 5 function) at limit=11 and reports 10/10 overflow", async () => {
    const res = await httpGet(port, "/api/graph/neighborhood?id=A1&limit=11");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.anchor).toBe("A1");
    expect(body.entities).toHaveLength(11); // anchor + 10

    const fileNames = body.entities
      .filter((e: { type: string }) => e.type === "file")
      .map((e: { name: string }) => e.name)
      .sort();
    const fnNames = body.entities
      .filter((e: { type: string }) => e.type === "function")
      .map((e: { name: string }) => e.name)
      .sort();
    expect(fileNames).toEqual(["file01", "file02", "file03", "file04", "file05"]);
    expect(fnNames).toEqual(["fn01", "fn02", "fn03", "fn04", "fn05"]);

    expect(body.entities.some((e: { id: string }) => e.id === "A1")).toBe(true);

    expect(body.overflow).toHaveLength(2);
    const fileOverflow = body.overflow.find((o: { type: string }) => o.type === "file");
    const fnOverflow = body.overflow.find((o: { type: string }) => o.type === "function");
    expect(fileOverflow).toEqual({ from: "A1", type: "file", omitted: 10 });
    expect(fnOverflow).toEqual({ from: "A1", type: "function", omitted: 10 });

    // relations[] includes only relations among included entities.
    expect(body.relations).toHaveLength(10);
    for (const r of body.relations) {
      expect(r.source === "A1" || r.target === "A1").toBe(true);
    }
  });

  it("is deterministic across repeated identical calls", async () => {
    const res1 = await httpGet(port, "/api/graph/neighborhood?id=A1&limit=11");
    const res2 = await httpGet(port, "/api/graph/neighborhood?id=A1&limit=11");
    expect(res1.body.toString("utf-8")).toBe(res2.body.toString("utf-8"));
  });

  it("defaults to depth=1, limit=150", async () => {
    const res = await httpGet(port, "/api/graph/neighborhood?id=A1");
    const body = JSON.parse(res.body.toString("utf-8"));
    // 31 total entities in the fixture, well under 150 -> everything included, no overflow.
    expect(body.entities).toHaveLength(31);
    expect(body.overflow).toEqual([]);
  });

  it("returns 404 for an unknown anchor id", async () => {
    const res = await httpGet(port, "/api/graph/neighborhood?id=NOPE999");
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.error).toBeTruthy();
  });

  it("returns 400 for a depth value other than 1 or 2", async () => {
    const res = await httpGet(port, "/api/graph/neighborhood?id=A1&depth=3");
    expect(res.status).toBe(400);
  });

  it("paging variant returns the requested slice, linking relations, and total_of_type", async () => {
    const res = await httpGet(port, "/api/graph/neighborhood?id=A1&type=file&offset=5&limit=5");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.anchor).toBe("A1");
    expect(body.total_of_type).toBe(15);
    const names = body.entities.map((e: { name: string }) => e.name);
    expect(names).toEqual(["file06", "file07", "file08", "file09", "file10"]);

    expect(body.relations).toHaveLength(5);
    for (const r of body.relations) {
      expect(r.source === "A1" || r.target === "A1").toBe(true);
    }
  });
});

describe("GET /api/graph/neighborhood - depth=2", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createSecondRingTestProject();
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

  it("pulls second-ring nodes within budget and records per-node overflow for the node that got cut", async () => {
    // budget = limit - 1 = 3. Depth-1 phase takes E2, E3 (both "file", degree
    // desc order: E2 degree=3 before E3 degree=2) -> budget left = 1.
    // Depth-2 walk order is [E2, E3] (same degree-desc/name-asc order).
    // E2's not-yet-included neighbors are [E5, E6] (both leaves, degree=1,
    // name asc, both type "file") -> only E5 fits in the remaining budget of
    // 1 -> overflow {from: E2, type: "file", omitted: 1}. Budget hits 0
    // before E3 is ever visited, so E3 gets no overflow entry despite E7
    // being excluded.
    const res = await httpGet(port, "/api/graph/neighborhood?id=A1&depth=2&limit=4");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString("utf-8"));

    const ids = body.entities.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["A1", "E2", "E3", "E5"]);

    expect(body.overflow).toEqual([{ from: "E2", type: "file", omitted: 1 }]);
  });

  it("depth=1 does not pull second-ring nodes even when budget would allow it", async () => {
    const res = await httpGet(port, "/api/graph/neighborhood?id=A1&depth=1&limit=10");
    const body = JSON.parse(res.body.toString("utf-8"));
    const ids = body.entities.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["A1", "E2", "E3"]);
    expect(body.overflow).toEqual([]);
  });
});

describe("GET /api/graph/neighborhood - depth=2 mixed-type overflow", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createSecondRingMixedTypeTestProject();
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

  it("groups a single node's depth-2 cut by type when the cut neighbors span multiple types", async () => {
    // budget = limit - 1 = 3. Depth-1 phase takes E2 (degree 6, "file") then
    // E3 (degree 2, "file") -> budget left = 1... wait: depth-1 group "file"
    // has exactly [E2, E3], both taken, leaving budget = 3 - 2 = 1 for
    // depth-2. Depth-2 walk order [E2 (degree 6), E3 (degree 2)]. E2's
    // not-yet-included neighbors sorted (degree desc [all =1], name asc):
    // [M1(file), M2(function), M3(file), M4(file), M5(function)]. Budget=1
    // -> only M1 added; cut = [M2(function), M3(file), M4(file), M5
    // (function)] -> grouped: file:2, function:2. Budget hits 0, E3 never
    // visited (no overflow entry for E3 despite E7 excluded).
    const res = await httpGet(port, "/api/graph/neighborhood?id=A1&depth=2&limit=4");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString("utf-8"));

    const ids = body.entities.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["A1", "E2", "E3", "M1"]);

    expect(body.overflow).toHaveLength(2);
    const fileOverflow = body.overflow.find((o: { type: string }) => o.type === "file");
    const fnOverflow = body.overflow.find((o: { type: string }) => o.type === "function");
    expect(fileOverflow).toEqual({ from: "E2", type: "file", omitted: 2 });
    expect(fnOverflow).toEqual({ from: "E2", type: "function", omitted: 2 });
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: legacy /api/graph exact-match route not shadowed       */
/* ------------------------------------------------------------------ */

describe("GET /api/graph - legacy exact-match route", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createGraphTestProject();
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

  it("does not intercept the legacy exact-match /api/graph route", async () => {
    const res = await httpGet(port, "/api/graph");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    // Legacy shape: full entities/relations arrays, not the scale-oriented
    // summary shape (no groups/hubs/group_edges).
    expect(body).toHaveProperty("entities");
    expect(body).toHaveProperty("relations");
    expect(body).toHaveProperty("entity_count");
    expect(body).toHaveProperty("relation_count");
    expect(body).not.toHaveProperty("groups");
    expect(body).not.toHaveProperty("hubs");
    expect(body.entities).toHaveLength(6);
    expect(body.relations).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------ */
/* Test suite: GET /api/health-report                                 */
/* ------------------------------------------------------------------ */

/** Fill in the required Decision fields not relevant to a given test with plausible defaults. */
function minimalDecisionFields(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "PLACEHOLDER",
    timestamp: "2026-02-17T09:00:00.000Z",
    agent_id: "test-agent",
    domain: "architecture",
    scope: "project",
    summary: "placeholder",
    context: "",
    rationale: "",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    status: "active",
    reversible: true,
    affected_files: [],
    affected_symbols: [],
    commit_hashes: [],
    ...overrides,
  };
}

/**
 * Fixture covering every health-report check:
 *  - DEC-STALE: scope is a nonexistent file path -> stale.
 *  - DEC-A -> DEC-B -> DEC-C: 3-link superseded chain, head DEC-C, length 3.
 *  - DEC-OTHER: unrelated active decision (must not appear anywhere).
 *  - 2 blackboard warnings at different ages (+ 1 non-warning entry, must be excluded).
 *  - 3 graph entities, 1 relation -> exactly 1 orphan (GE3).
 *  - 2 handoffs, 1 acknowledged (must be excluded), 1 not.
 *
 * Non-stale decisions use scope "project" deliberately — staleness.ts treats
 * "project"/"global" as categorical (no path check); a path-like scope like
 * "src/" would falsely flag them stale since the temp project root has no
 * such directory on disk.
 */
function createHealthReportTestProject(): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-query-health-test-"),
  );
  const twiningDir = path.join(projectRoot, ".twining");
  const decisionsDir = path.join(twiningDir, "decisions");
  const graphDir = path.join(twiningDir, "graph");
  const handoffsDir = path.join(twiningDir, "handoffs");
  const publicDir = path.join(projectRoot, "public");

  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(handoffsDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<html><body>Dashboard</body></html>",
  );

  const bbEntries = [
    {
      id: "BBW1",
      timestamp: "2026-01-01T08:00:00.000Z", // older
      agent_id: "test-agent",
      entry_type: "warning",
      tags: [],
      scope: "project",
      summary: "Older warning",
      detail: "detail",
    },
    {
      id: "BBW2",
      timestamp: "2026-02-01T08:00:00.000Z", // newer
      agent_id: "test-agent",
      entry_type: "warning",
      tags: [],
      scope: "project",
      summary: "Newer warning",
      detail: "detail",
    },
    {
      id: "BBF1",
      timestamp: "2026-02-02T08:00:00.000Z",
      agent_id: "test-agent",
      entry_type: "finding",
      tags: [],
      scope: "project",
      summary: "Not a warning — must not appear",
      detail: "detail",
    },
  ];
  fs.writeFileSync(
    path.join(twiningDir, "blackboard.jsonl"),
    bbEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  const indexEntries = [
    { id: "DEC-STALE", timestamp: "2026-02-17T09:00:00.000Z", domain: "architecture", scope: "does/not/exist/file.ts", summary: "Decision with a dead scope path", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
    { id: "DEC-A", timestamp: "2026-02-17T09:01:00.000Z", domain: "architecture", scope: "project", summary: "Decision A (earliest)", confidence: "medium", status: "superseded", affected_files: [], affected_symbols: [], commit_hashes: [] },
    { id: "DEC-B", timestamp: "2026-02-17T09:02:00.000Z", domain: "architecture", scope: "project", summary: "Decision B (middle)", confidence: "medium", status: "superseded", affected_files: [], affected_symbols: [], commit_hashes: [] },
    { id: "DEC-C", timestamp: "2026-02-17T09:03:00.000Z", domain: "architecture", scope: "project", summary: "Decision C (chain head)", confidence: "medium", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
    { id: "DEC-OTHER", timestamp: "2026-02-17T09:04:00.000Z", domain: "api", scope: "project", summary: "Unrelated active decision", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
  ];
  fs.writeFileSync(path.join(decisionsDir, "index.json"), JSON.stringify(indexEntries, null, 2));

  // Full decision files only for status==="superseded" entries — the chain
  // walk must read FULL decisions bounded by the superseded count, never
  // the full decision set (checked by the timing pass against the 5k fixture).
  fs.writeFileSync(
    path.join(decisionsDir, "DEC-A.json"),
    JSON.stringify(minimalDecisionFields({ id: "DEC-A", summary: "Decision A (earliest)", status: "superseded", superseded_by: "DEC-B" }), null, 2),
  );
  fs.writeFileSync(
    path.join(decisionsDir, "DEC-B.json"),
    JSON.stringify(minimalDecisionFields({ id: "DEC-B", summary: "Decision B (middle)", status: "superseded", superseded_by: "DEC-C" }), null, 2),
  );

  const entities = [
    { id: "GE1", name: "hub.ts", type: "file", properties: {}, created_at: "2026-02-17T08:00:00.000Z", updated_at: "2026-02-17T08:00:00.000Z" },
    { id: "GE2", name: "leaf.ts", type: "file", properties: {}, created_at: "2026-02-17T08:01:00.000Z", updated_at: "2026-02-17T08:01:00.000Z" },
    { id: "GE3", name: "orphan.ts", type: "file", properties: {}, created_at: "2026-02-17T08:02:00.000Z", updated_at: "2026-02-17T08:02:00.000Z" },
  ];
  const relations = [
    { id: "GR1", source: "GE1", target: "GE2", type: "contains", properties: {}, created_at: "2026-02-17T09:00:00.000Z" },
  ];
  fs.writeFileSync(path.join(graphDir, "entities.json"), JSON.stringify(entities, null, 2));
  fs.writeFileSync(path.join(graphDir, "relations.json"), JSON.stringify(relations, null, 2));

  const handoffIndexEntries = [
    { id: "HO1", created_at: "2026-01-15T08:00:00.000Z", source_agent: "agent-a", target_agent: "agent-b", scope: "project", summary: "Unacknowledged handoff", result_status: "completed", acknowledged: false },
    { id: "HO2", created_at: "2026-01-20T08:00:00.000Z", source_agent: "agent-a", target_agent: "agent-b", scope: "project", summary: "Acknowledged handoff", result_status: "completed", acknowledged: true },
  ];
  fs.writeFileSync(
    path.join(handoffsDir, "index.jsonl"),
    handoffIndexEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  return { projectRoot, publicDir };
}

describe("GET /api/health-report", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = createHealthReportTestProject();
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

  it("flags the decision with a dead scope path as stale, worst-first, with string reasons", async () => {
    const res = await httpGet(port, "/api/health-report");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body.toString("utf-8"));
    const stale = body.stale_decisions.find((d: { id: string }) => d.id === "DEC-STALE");
    expect(stale).toBeDefined();
    expect(stale.scope).toBe("does/not/exist/file.ts");
    expect(stale.score).toBeGreaterThanOrEqual(0.95);
    expect(Array.isArray(stale.reasons)).toBe(true);
    expect(stale.reasons.length).toBeGreaterThan(0);
    expect(typeof stale.reasons[0]).toBe("string");

    expect(body.stale_decisions.some((d: { id: string }) => d.id === "DEC-OTHER")).toBe(false);
  });

  it("returns unresolved warnings sorted oldest first, excluding non-warning entries", async () => {
    const res = await httpGet(port, "/api/health-report");
    const body = JSON.parse(res.body.toString("utf-8"));

    const ids = body.unresolved_warnings.map((w: { id: string }) => w.id);
    expect(ids).toEqual(["BBW1", "BBW2"]);
    expect(body.unresolved_warnings[0].age_days).toBeGreaterThanOrEqual(
      body.unresolved_warnings[1].age_days,
    );
    expect(
      body.unresolved_warnings.every(
        (w: { summary: string }) => w.summary !== "Not a warning — must not appear",
      ),
    ).toBe(true);
  });

  it("walks a 3-link superseded chain to its terminal head", async () => {
    const res = await httpGet(port, "/api/health-report");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.superseded_chains).toHaveLength(1);
    expect(body.superseded_chains[0]).toEqual({
      head_id: "DEC-C",
      head_summary: "Decision C (chain head)",
      length: 3,
    });
  });

  it("reports orphan entity count and a capped sample", async () => {
    const res = await httpGet(port, "/api/health-report");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.orphan_entities.count).toBe(1);
    expect(body.orphan_entities.sample).toHaveLength(1);
    expect(body.orphan_entities.sample[0]).toEqual({ id: "GE3", name: "orphan.ts", type: "file" });
  });

  it("returns only unacknowledged handoffs", async () => {
    const res = await httpGet(port, "/api/health-report");
    const body = JSON.parse(res.body.toString("utf-8"));

    expect(body.unacknowledged_handoffs).toHaveLength(1);
    expect(body.unacknowledged_handoffs[0].id).toBe("HO1");
    expect(body.unacknowledged_handoffs[0]).toHaveProperty("age_days");
  });

  it("caches the whole report for 60s — two consecutive requests return identical generated_at", async () => {
    const res1 = await httpGet(port, "/api/health-report");
    const res2 = await httpGet(port, "/api/health-report");
    const body1 = JSON.parse(res1.body.toString("utf-8"));
    const body2 = JSON.parse(res2.body.toString("utf-8"));

    expect(body2.generated_at).toBe(body1.generated_at);
    expect(body2).toEqual(body1);
  });
});

describe("GET /api/health-report - uninitialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-query-health-uninit-"),
    );
    const publicDir = path.join(projectRoot, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, "index.html"),
      "<html><body>Empty</body></html>",
    );

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

  it("returns empty lists when .twining/ does not exist", async () => {
    const res = await httpGet(port, "/api/health-report");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.stale_decisions).toEqual([]);
    expect(body.unresolved_warnings).toEqual([]);
    expect(body.superseded_chains).toEqual([]);
    expect(body.orphan_entities).toEqual({ count: 0, sample: [] });
    expect(body.unacknowledged_handoffs).toEqual([]);
    expect(typeof body.generated_at).toBe("string");
  });
});
