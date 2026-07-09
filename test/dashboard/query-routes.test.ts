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
