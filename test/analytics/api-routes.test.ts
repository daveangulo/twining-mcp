import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleRequest } from "../../src/dashboard/http-server.js";
import { appendJSONL, writeJSON } from "../../src/storage/file-store.js";

function httpGet(
  port: number,
  urlPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Analytics API routes", () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-analytics-api-test-"),
    );
    const twiningDir = path.join(projectRoot, ".twining");
    const decisionsDir = path.join(twiningDir, "decisions");
    const graphDir = path.join(twiningDir, "graph");
    const agentsDir = path.join(twiningDir, "agents");
    const handoffsDir = path.join(twiningDir, "handoffs");
    const publicDir = path.join(projectRoot, "public");

    fs.mkdirSync(decisionsDir, { recursive: true });
    fs.mkdirSync(graphDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.mkdirSync(publicDir, { recursive: true });

    // Seed data
    fs.writeFileSync(path.join(twiningDir, "blackboard.jsonl"), "");
    await appendJSONL(path.join(twiningDir, "blackboard.jsonl"), {
      id: "w1", entry_type: "warning", summary: "Test warning", detail: "",
      scope: "src/", agent_id: "a1", timestamp: "2024-01-01T00:00:00Z",
      tags: ["acknowledged"], relates_to: [],
    });

    await writeJSON(path.join(decisionsDir, "index.json"), [
      {
        id: "d1", timestamp: "2024-01-01T00:00:00Z", domain: "arch",
        scope: "src/", summary: "dec1", confidence: "high", status: "active",
        affected_files: [], affected_symbols: [], commit_hashes: ["abc"],
      },
    ]);
    await writeJSON(path.join(decisionsDir, "d1.json"), {
      id: "d1", timestamp: "2024-01-01T00:00:00Z", domain: "arch",
      scope: "src/", summary: "dec1", confidence: "high", status: "active",
      affected_files: [], affected_symbols: [], commit_hashes: ["abc"],
      assembled_before: true,
    });
    await writeJSON(path.join(graphDir, "entities.json"), [
      { id: "e1", name: "Mod", type: "module", properties: {} },
    ]);
    await writeJSON(path.join(graphDir, "relations.json"), []);
    await writeJSON(path.join(agentsDir, "registry.json"), []);

    // Seed metrics
    await appendJSONL(path.join(twiningDir, "metrics.jsonl"), {
      tool_name: "twining_post", timestamp: "2024-01-01T00:00:00Z",
      duration_ms: 50, success: true, agent_id: "test",
    });
    await appendJSONL(path.join(twiningDir, "metrics.jsonl"), {
      tool_name: "twining_decide", timestamp: "2024-01-01T00:00:00Z",
      duration_ms: 100, success: false, error_code: "CONFLICT",
      agent_id: "test",
    });

    server = http.createServer(handleRequest(publicDir, projectRoot));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("GET /api/analytics/value-stats returns value metrics", async () => {
    const res = await httpGet(port, "/api/analytics/value-stats");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.blind_decisions_prevented).toBeDefined();
    expect(data.blind_decisions_prevented.total_decisions).toBe(1);
    expect(data.blind_decisions_prevented.assembled_before).toBe(1);
    expect(data.warnings_surfaced.total).toBe(1);
    expect(data.knowledge_graph.entities).toBe(1);
  });

  it("GET /api/analytics/tool-usage returns tool usage summary", async () => {
    const res = await httpGet(port, "/api/analytics/tool-usage");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.tools).toBeDefined();
    expect(data.tools.length).toBe(2);
    const post = data.tools.find((t: { tool_name: string }) => t.tool_name === "twining_post");
    expect(post).toBeDefined();
    expect(post.call_count).toBe(1);
  });

  it("GET /api/analytics/tool-usage-over-time returns time buckets", async () => {
    const res = await httpGet(port, "/api/analytics/tool-usage-over-time?bucket=60");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.buckets).toBeDefined();
    expect(data.buckets.length).toBeGreaterThan(0);
  });

  it("GET /api/analytics/errors returns error breakdown", async () => {
    const res = await httpGet(port, "/api/analytics/errors");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.errors).toBeDefined();
    expect(data.errors.length).toBe(1);
    expect(data.errors[0].tool_name).toBe("twining_decide");
    expect(data.errors[0].error_code).toBe("CONFLICT");
  });
});
