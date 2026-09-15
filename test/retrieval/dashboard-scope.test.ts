/**
 * The dashboard's `/api/index` scope filter (R13).
 *
 * The dashboard had no scope parameter: it returned the whole store. That is
 * not a leak (the store is the boundary), but it meant the one surface most
 * likely to grow a scope filter later would have grown an UNGATED one. The
 * filter is therefore introduced already running the shared pre-ranking gate.
 *
 * Two properties are asserted: absent the parameter nothing changes, and
 * present it matches on segment boundaries rather than 2.x's raw `startsWith`.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { createQueryHandler } from "../../src/dashboard/query-routes.js";
import { BlackboardStore } from "../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../src/storage/decision-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twining-dash-scope-"));
  dirs.push(root);
  const tw = path.join(root, ".twining");
  fs.mkdirSync(path.join(tw, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(tw, "graph"), { recursive: true });
  fs.writeFileSync(path.join(tw, "blackboard.jsonl"), "");
  fs.writeFileSync(path.join(tw, "decisions", "index.json"), JSON.stringify([]));
  return root;
}

/** Drive the handler without a socket: capture what it would have written. */
async function call(root: string, url: string): Promise<{ status: number; body: any }> {
  const handler = createQueryHandler(root);
  let status = 200;
  let payload = "";
  const req = { url, method: "GET", headers: {} } as unknown as http.IncomingMessage;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") payload = chunk;
      else if (Buffer.isBuffer(chunk)) payload = chunk.toString("utf8");
      return this;
    },
  } as unknown as http.ServerResponse;
  await handler(req, res);
  return { status, body: payload ? JSON.parse(payload) : null };
}

async function seed(root: string): Promise<void> {
  const tw = path.join(root, ".twining");
  const bb = new BlackboardStore(tw);
  const ds = new DecisionStore(tw);
  await bb.append({ agent_id: "t", entry_type: "finding", tags: [], scope: "src/auth/", summary: "auth finding", detail: "" });
  await bb.append({ agent_id: "t", entry_type: "finding", tags: [], scope: "src/authz/", summary: "authz finding", detail: "" });
  await bb.append({ agent_id: "t", entry_type: "finding", tags: [], scope: "vendor/billing/", summary: "billing finding", detail: "" });
  await ds.create({
    agent_id: "t",
    domain: "implementation",
    scope: "src/auth/jwt/",
    summary: "nested auth decision",
    context: "c",
    rationale: "r",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "high",
    reversible: true,
    affected_files: [],
    affected_symbols: [],
  });
}

describe("dashboard /api/index scope filter", () => {
  it("without the parameter, every row is returned — behaviour is unchanged", async () => {
    const root = project();
    await seed(root);
    const { body } = await call(root, "/api/index");
    expect(body.initialized).toBe(true);
    expect(body.rows).toHaveLength(4);
    // The additive reporting fields are absent when no filter was applied.
    expect(body.scope).toBeUndefined();
    expect(body.scope_filtered).toBeUndefined();
  });

  it("with a scope, the gate matches on SEGMENT boundaries: src/auth never matches src/authz", async () => {
    const root = project();
    await seed(root);
    const { body } = await call(root, "/api/index?scope=src/auth/");
    const summaries = body.rows.map((r: { summary: string }) => r.summary).sort();
    // The in-scope finding and the NESTED decision are returned...
    expect(summaries).toEqual(["auth finding", "nested auth decision"]);
    // ...and the sibling module is not, despite `"src/authz/".startsWith("src/auth")`.
    expect("src/authz/".startsWith("src/auth")).toBe(true);
    expect(summaries).not.toContain("authz finding");
    expect(summaries).not.toContain("billing finding");
  });

  it("reports how many rows the filter removed, so the reduction is not silent", async () => {
    const root = project();
    await seed(root);
    const { body } = await call(root, "/api/index?scope=src/auth/");
    expect(body.scope).toBe("src/auth/");
    expect(body.scope_filtered).toBe(2);
  });

  it("a broad scope covers its narrower children", async () => {
    const root = project();
    await seed(root);
    const { body } = await call(root, "/api/index?scope=src/");
    const summaries = body.rows.map((r: { summary: string }) => r.summary).sort();
    expect(summaries).toEqual(["auth finding", "authz finding", "nested auth decision"]);
  });

  it("an unrelated scope returns nothing rather than a best-effort set", async () => {
    const root = project();
    await seed(root);
    const { body } = await call(root, "/api/index?scope=docs/");
    expect(body.rows).toEqual([]);
    expect(body.scope_filtered).toBe(4);
  });
});
