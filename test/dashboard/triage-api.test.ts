/**
 * HTTP adapter tests for GET /api/triage (TRIAGE-SPEC §7, §10.14 HTTP-side,
 * §10.11 HTTP-side). Mirrors the server/httpGet patterns of
 * test/dashboard/http-server.test.ts; buildTriage semantics themselves are
 * covered in test/triage-engine.test.ts — these tests pin the adapter:
 * routing, param parsing, the uninitialized zero shape, and stdout silence.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleRequest } from "../../src/dashboard/http-server.js";
import { buildTriage } from "../../src/engine/triage.js";
import { BlackboardStore } from "../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../src/storage/decision-store.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import type { DashboardDeps } from "../../src/dashboard/api-routes.js";
import type {
  BlackboardEntry,
  Decision,
  DecisionIndexEntry,
} from "../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_WINDOW_MS = 604_800_000;

const ZERO_COUNTS = {
  open: {
    total: 0,
    irreversible: 0,
    by_kind: { decision: 0, need: 0, question: 0, warning: 0 },
  },
  recent: {
    total: 0,
    irreversible: 0,
    by_kind: { decision: 0, artifact: 0 },
  },
};

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

function makeEntry(
  id: string,
  type: BlackboardEntry["entry_type"],
  timestamp: string,
  extra: Partial<BlackboardEntry> = {},
): BlackboardEntry {
  return {
    id,
    timestamp,
    agent_id: "main",
    entry_type: type,
    tags: ["test"],
    scope: "src/",
    summary: `${type} ${id}`,
    detail: "",
    ...extra,
  };
}

function makeDecision(
  id: string,
  timestamp: string,
  extra: Partial<Decision> = {},
): Decision {
  return {
    id,
    timestamp,
    agent_id: "main",
    domain: "test",
    scope: "src/",
    summary: `decision ${id}`,
    context: "",
    rationale: "because reasons",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    status: "active",
    reversible: true,
    affected_files: [],
    affected_symbols: [],
    commit_hashes: [],
    ...extra,
  };
}

function toIndexEntry(decision: Decision): DecisionIndexEntry {
  return {
    id: decision.id,
    timestamp: decision.timestamp,
    domain: decision.domain,
    scope: decision.scope,
    summary: decision.summary,
    confidence: decision.confidence,
    status: decision.status,
    affected_files: decision.affected_files,
    affected_symbols: decision.affected_symbols,
    commit_hashes: decision.commit_hashes,
  };
}

/**
 * Seed a file-backend project (backend pinned via config.yml so the
 * backend-aware createStores path is deterministic across Node versions).
 */
function seedProject(
  entries: BlackboardEntry[],
  decisions: Decision[],
): { projectRoot: string; publicDir: string; twiningDir: string } {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-triage-api-"),
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
  fs.writeFileSync(
    path.join(twiningDir, "config.yml"),
    "storage:\n  backend: files\n",
  );
  fs.writeFileSync(
    path.join(twiningDir, "blackboard.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") +
      (entries.length ? "\n" : ""),
  );
  for (const decision of decisions) {
    fs.writeFileSync(
      path.join(decisionsDir, `${decision.id}.json`),
      JSON.stringify(decision, null, 2),
    );
  }
  fs.writeFileSync(
    path.join(decisionsDir, "index.json"),
    JSON.stringify(decisions.map(toIndexEntry), null, 2),
  );
  return { projectRoot, publicDir, twiningDir };
}

async function startServer(
  publicDir: string,
  projectRoot: string,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handleRequest(publicDir, projectRoot));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { server, port };
}

/* ------------------------------------------------------------------ */
/* Initialized project                                                 */
/* ------------------------------------------------------------------ */

describe("GET /api/triage - initialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;
  let twiningDir: string;

  const recent = new Date(Date.now() - 60_000).toISOString();
  const outOfWindow = "2026-01-01T00:00:00.000Z";

  beforeAll(async () => {
    const project = seedProject(
      [
        makeEntry("bb-need", "need", recent, { scope: "src/auth/" }),
        makeEntry("bb-artifact", "artifact", recent),
        makeEntry("bb-artifact-old", "artifact", outOfWindow),
      ],
      [
        makeDecision("dec-prov", recent, { status: "provisional" }),
        makeDecision("dec-active", recent),
        makeDecision("dec-active-old", outOfWindow),
      ],
    );
    projectRoot = project.projectRoot;
    twiningDir = project.twiningDir;
    ({ server, port } = await startServer(project.publicDir, projectRoot));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("routes with a query string present (parsed-pathname match)", async () => {
    const res = await httpGet(port, "/api/triage?section=open");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.section).toBe("open");
    expect(Array.isArray(body.open)).toBe(true);
    expect(body).not.toHaveProperty("recent");
    // counts always cover both buckets regardless of section
    expect(body.counts.open.total).toBe(2);
    expect(body.counts.recent.total).toBe(2);
  });

  it("returns classified buckets on the plain path", async () => {
    const res = await httpGet(port, "/api/triage");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.window_ms).toBe(DEFAULT_WINDOW_MS);
    expect(body.section).toBe("all");
    expect(body.counts.open.by_kind).toEqual({
      decision: 1,
      need: 1,
      question: 0,
      warning: 0,
    });
    expect(body.counts.recent.by_kind).toEqual({ decision: 1, artifact: 1 });
    expect(body.open.map((i: { id: string }) => i.id).sort()).toEqual([
      "bb-need",
      "dec-prov",
    ]);
    expect(body.recent.map((i: { id: string }) => i.id).sort()).toEqual([
      "bb-artifact",
      "dec-active",
    ]);
  });

  it("defaults non-numeric window_ms and limit params", async () => {
    const res = await httpGet(port, "/api/triage?window_ms=abc&limit=xyz");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.window_ms).toBe(DEFAULT_WINDOW_MS);
    expect(body.counts.open.total).toBe(2);
    expect(body.counts.recent.total).toBe(2);
  });

  it("applies window_ms=Infinity as an unbounded window (§4.1: > 0 is applied, no upper clamp)", async () => {
    // Number("Infinity") passes the adapter's NaN guard and flows to the
    // shared normalization, which applies it: the out-of-window items enter
    // recent. The echoed window_ms serializes to JSON null — Infinity has
    // no JSON representation (documented wrinkle in normalize()).
    const res = await httpGet(port, "/api/triage?window_ms=Infinity");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.window_ms).toBeNull();
    expect(body.counts.recent.total).toBe(4);
    expect(body.recent.map((i: { id: string }) => i.id).sort()).toEqual([
      "bb-artifact",
      "bb-artifact-old",
      "dec-active",
      "dec-active-old",
    ]);
  });

  it("window_ms=-1 defaults identically to a direct buildTriage call", async () => {
    const res = await httpGet(port, "/api/triage?window_ms=-1");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);

    const direct = await buildTriage(
      {
        decisionStore: new DecisionStore(twiningDir),
        blackboardStore: new BlackboardStore(twiningDir),
      },
      { window_ms: -1 },
    );
    expect(body.window_ms).toBe(DEFAULT_WINDOW_MS);
    expect(body.window_ms).toBe(direct.window_ms);
    expect(body.counts).toEqual(direct.counts);
  });

  it("treats empty-string params as absent and does not echo them", async () => {
    const res = await httpGet(port, "/api/triage?scope=&for_agent=&since=");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("for_agent");
    expect(body).not.toHaveProperty("since");
    // identical result to omitting the params
    const plain = JSON.parse((await httpGet(port, "/api/triage")).body);
    expect(body.counts).toEqual(plain.counts);
  });

  it("echoes provided non-empty scope and valid since", async () => {
    const res = await httpGet(
      port,
      "/api/triage?scope=src/auth/&since=2026-01-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.scope).toBe("src/auth/");
    expect(body.since).toBe("2026-01-01T00:00:00.000Z");
  });

  it("ignores unparseable since and does not echo it", async () => {
    const res = await httpGet(port, "/api/triage?since=not-a-date");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty("since");
    expect(body.counts.recent.total).toBe(2);
  });

  it("ignores unknown params", async () => {
    const res = await httpGet(port, "/api/triage?bogus=1&section=recent");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.section).toBe("recent");
    expect(body).not.toHaveProperty("bogus");
    expect(body).not.toHaveProperty("open");
    expect(Array.isArray(body.recent)).toBe(true);
  });

  it("does not match longer pathnames (falls through)", async () => {
    const res = await httpGet(port, "/api/triagex");
    expect(res.status).toBe(404);
  });

  it("writes nothing to stdout while serving triage requests", async () => {
    const spy = vi.spyOn(process.stdout, "write");
    try {
      await httpGet(port, "/api/triage?section=open&window_ms=abc&since=bad");
      await httpGet(port, "/api/triage");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Uninitialized project (§10.11 HTTP zero shape)                      */
/* ------------------------------------------------------------------ */

describe("GET /api/triage - uninitialized project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-triage-uninit-"),
    );
    const publicDir = path.join(projectRoot, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, "index.html"),
      "<html><body>Empty</body></html>",
    );
    // No .twining/ directory created
    ({ server, port } = await startServer(publicDir, projectRoot));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns 200 with the full zero shape, field-for-field", async () => {
    const res = await httpGet(port, "/api/triage");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(typeof body.generated_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.generated_at))).toBe(false);
    delete body.generated_at;
    expect(body).toEqual({
      initialized: false,
      window_ms: DEFAULT_WINDOW_MS,
      section: "all",
      open: [],
      recent: [],
      counts: ZERO_COUNTS,
    });
  });

  it("applies the same-params rule to the zero shape", async () => {
    const res = await httpGet(
      port,
      "/api/triage?section=recent&scope=src/&window_ms=1000" +
        "&since=2026-01-01T00:00:00.000Z&for_agent=alice",
    );
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    delete body.generated_at;
    expect(body).toEqual({
      initialized: false,
      window_ms: 1000,
      section: "recent",
      scope: "src/",
      for_agent: "alice",
      since: "2026-01-01T00:00:00.000Z",
      recent: [],
      counts: ZERO_COUNTS,
    });
  });

  it("empty-string and invalid params in the zero shape behave as absent", async () => {
    const res = await httpGet(
      port,
      "/api/triage?scope=&for_agent=&since=not-a-date&window_ms=abc",
    );
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    delete body.generated_at;
    expect(body).toEqual({
      initialized: false,
      window_ms: DEFAULT_WINDOW_MS,
      section: "all",
      open: [],
      recent: [],
      counts: ZERO_COUNTS,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Initialized-empty is distinct from uninitialized                    */
/* ------------------------------------------------------------------ */

describe("GET /api/triage - initialized empty project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = seedProject([], []);
    projectRoot = project.projectRoot;
    ({ server, port } = await startServer(project.publicDir, projectRoot));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns initialized:true with zero counts", async () => {
    const res = await httpGet(port, "/api/triage");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.open).toEqual([]);
    expect(body.recent).toEqual([]);
    expect(body.counts).toEqual(ZERO_COUNTS);
  });
});

/* ------------------------------------------------------------------ */
/* Sqlite-backend project — backend-aware store construction (§7)      */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_SQLITE)("GET /api/triage - sqlite backend project", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-triage-sqlite-api-"),
    );
    const twiningDir = path.join(projectRoot, ".twining");
    const publicDir = path.join(projectRoot, "public");
    fs.mkdirSync(twiningDir, { recursive: true });
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, "index.html"),
      "<html><body>Dashboard</body></html>",
    );
    fs.writeFileSync(
      path.join(twiningDir, "config.yml"),
      "storage:\n  backend: sqlite\n",
    );
    // Seed rows directly in twining.db; no .twining/records/ tree exists, so
    // the startup ingest skips entirely and the rows survive server open.
    const recent = new Date(Date.now() - 60_000).toISOString();
    const db = openDatabase(twiningDir);
    const decision = makeDecision("dec-sqlite-prov", recent, {
      status: "provisional",
    });
    db.prepare(
      "INSERT INTO decisions (id, status, timestamp, data) VALUES (?, ?, ?, ?)",
    ).run(decision.id, decision.status, decision.timestamp, JSON.stringify(decision));
    const entry = makeEntry("bb-sqlite-need", "need", recent);
    db.prepare(
      "INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)",
    ).run(entry.id, entry.entry_type, entry.scope, entry.timestamp, JSON.stringify(entry));
    db.close();
    ({ server, port } = await startServer(publicDir, projectRoot));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("serves seeded sqlite rows — the raw file-store fallback would return empty data", async () => {
    const res = await httpGet(port, "/api/triage");
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.initialized).toBe(true);
    expect(body.counts.open.total).toBe(2);
    expect(body.open.map((i: { id: string }) => i.id).sort()).toEqual([
      "bb-sqlite-need",
      "dec-sqlite-prov",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Error path — 500 envelope, stderr-only logging (§7)                 */
/* ------------------------------------------------------------------ */

describe("GET /api/triage - error path", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    const project = seedProject([], []);
    projectRoot = project.projectRoot;
    // Poison only the triage read path: with deps present, the triage route
    // uses deps.decisionStore/blackboardStore directly; other routes fall
    // back per-field and are not exercised here.
    const deps = {
      decisionStore: {
        getIndex: async () => {
          throw new Error("triage boom");
        },
        get: async () => null,
      },
      blackboardStore: new BlackboardStore(project.twiningDir),
    } as Partial<DashboardDeps> as DashboardDeps;
    server = http.createServer(
      handleRequest(project.publicDir, projectRoot, deps),
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

  it("returns the JSON 500 envelope and logs to stderr only", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await httpGet(port, "/api/triage");
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
      expect(errorSpy).toHaveBeenCalledWith(
        "[twining] API /api/triage error:",
        expect.any(Error),
      );
      // Assert BEFORE mockRestore — restore clears mock.calls.
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
