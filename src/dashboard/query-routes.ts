/**
 * Scale-oriented dashboard query endpoints (compact index, graph drill-down,
 * health report). Additive to api-routes.ts.
 * CRITICAL: never write to stdout — MCP owns it. console.error only.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import type { DashboardDeps } from "./api-routes.js";
import type { IBlackboardStore, IDecisionStore, IGraphStore } from "../storage/interfaces.js";

const SUMMARY_MAX = 120;

function truncate(s: string): string {
  return s.length <= SUMMARY_MAX ? s : s.slice(0, SUMMARY_MAX - 1) + "…";
}

/** Send JSON, gzipping when the client accepts it and the body is large. */
function sendJSON(req: http.IncomingMessage, res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  };
  if (acceptsGzip && body.length > 8192) {
    headers["Content-Encoding"] = "gzip";
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body));
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

export function createQueryHandler(
  projectRoot: string,
  deps?: DashboardDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const twiningDir = path.join(projectRoot, ".twining");
  const blackboardStore: IBlackboardStore = deps?.blackboardStore ?? new BlackboardStore(twiningDir);
  const decisionStore: IDecisionStore = deps?.decisionStore ?? new DecisionStore(twiningDir);
  const graphStore: IGraphStore = deps?.graphStore ?? new GraphStore(twiningDir);
  void graphStore; // used from Task 4 on

  return async (req, res) => {
    const url = req.url || "/";
    const parsed = new URL(url, "http://localhost");
    const route = parsed.pathname;

    if (route === "/api/index") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(req, res, { initialized: false, rows: [], total_counts: { blackboard: 0, decisions: { active: 0, provisional: 0, superseded: 0, overridden: 0 } }, generated_at: new Date().toISOString() });
          return true;
        }
        const since = parsed.searchParams.get("since");
        const [{ entries, total_count }, decIndex] = await Promise.all([
          blackboardStore.read(),
          decisionStore.getIndex(),
        ]);
        const decCounts = { active: 0, provisional: 0, superseded: 0, overridden: 0 } as Record<string, number>;
        for (const d of decIndex) decCounts[d.status] = (decCounts[d.status] ?? 0) + 1;

        const rows = [
          ...entries.map((e) => ({
            id: e.id, kind: "blackboard" as const, timestamp: e.timestamp,
            entry_type: e.entry_type, scope: e.scope, summary: truncate(e.summary),
            tags: e.tags.length ? e.tags : undefined,
          })),
          ...decIndex.map((d) => ({
            id: d.id, kind: "decision" as const, timestamp: d.timestamp,
            scope: d.scope, summary: truncate(d.summary),
            domain: d.domain, status: d.status, confidence: d.confidence,
          })),
        ]
          .filter((r) => !since || r.timestamp > since)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        sendJSON(req, res, {
          initialized: true, rows,
          total_counts: { blackboard: total_count, decisions: decCounts },
          generated_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[twining] /api/index error:", err);
        sendJSON(req, res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    return false;
  };
}
