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
import type { Relation } from "../utils/types.js";

const SUMMARY_MAX = 120;
const HUB_LIMIT = 20;
const DEFAULT_ENTITIES_LIMIT = 50;

function truncate(s: string): string {
  return s.length <= SUMMARY_MAX ? s : s.slice(0, SUMMARY_MAX - 1) + "…";
}

/** Each relation increments the degree of both its source and target entity. */
function buildDegreeMap(relations: Relation[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const r of relations) {
    degree.set(r.source, (degree.get(r.source) ?? 0) + 1);
    degree.set(r.target, (degree.get(r.target) ?? 0) + 1);
  }
  return degree;
}

/** Lexicographic name comparator (no locale surprises — plain string ordering). */
function compareNames(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
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

  return async (req, res) => {
    const url = req.url || "/";
    const parsed = new URL(url, "http://localhost");
    const route = parsed.pathname;

    if (route.startsWith("/api/blackboard/")) {
      try {
        const id = route.slice("/api/blackboard/".length);
        if (!id) {
          sendJSON(req, res, { error: "Blackboard entry ID required" }, 400);
          return true;
        }

        if (!fs.existsSync(twiningDir)) {
          sendJSON(req, res, { error: "Blackboard entry not found" }, 404);
          return true;
        }

        const { entries } = await blackboardStore.read();
        const entry = entries.find((e) => e.id === id);
        if (!entry) {
          sendJSON(req, res, { error: "Blackboard entry not found" }, 404);
          return true;
        }

        sendJSON(req, res, entry);
      } catch (err) {
        console.error("[twining] /api/blackboard/:id error:", err);
        sendJSON(req, res, { error: "Internal server error" }, 500);
      }
      return true;
    }

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

    if (route === "/api/graph/summary") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(req, res, {
            initialized: false, groups: [], group_edges: [], hubs: [],
            orphan_count: 0, entity_count: 0, relation_count: 0,
          });
          return true;
        }

        const [entities, relations] = await Promise.all([
          graphStore.getEntities(),
          graphStore.getRelations(),
        ]);
        const degreeMap = buildDegreeMap(relations);
        const entityById = new Map(entities.map((e) => [e.id, e]));

        const groupCounts = new Map<string, number>();
        for (const e of entities) groupCounts.set(e.type, (groupCounts.get(e.type) ?? 0) + 1);
        const groups = [...groupCounts.entries()].map(([type, count]) => ({ type, count }));

        // group_edges: unordered type-pair aggregation. Relations whose
        // source/target entity is missing are skipped here (but still
        // counted in relation_count below).
        const edgeMap = new Map<string, { source_type: string; target_type: string; relation_counts: Record<string, number>; total: number }>();
        for (const r of relations) {
          const srcEntity = entityById.get(r.source);
          const tgtEntity = entityById.get(r.target);
          if (!srcEntity || !tgtEntity) continue;
          const typeA = srcEntity.type <= tgtEntity.type ? srcEntity.type : tgtEntity.type;
          const typeB = srcEntity.type <= tgtEntity.type ? tgtEntity.type : srcEntity.type;
          const key = `${typeA}→${typeB}`;
          let edge = edgeMap.get(key);
          if (!edge) {
            edge = { source_type: typeA, target_type: typeB, relation_counts: {}, total: 0 };
            edgeMap.set(key, edge);
          }
          edge.relation_counts[r.type] = (edge.relation_counts[r.type] ?? 0) + 1;
          edge.total += 1;
        }
        const group_edges = [...edgeMap.values()];

        const hubs = entities
          .map((e) => ({ id: e.id, name: e.name, type: e.type, degree: degreeMap.get(e.id) ?? 0 }))
          .sort((a, b) => b.degree - a.degree || compareNames(a.name, b.name))
          .slice(0, HUB_LIMIT);

        const orphan_count = entities.filter((e) => (degreeMap.get(e.id) ?? 0) === 0).length;

        sendJSON(req, res, {
          initialized: true, groups, group_edges, hubs, orphan_count,
          entity_count: entities.length, relation_count: relations.length,
        });
      } catch (err) {
        console.error("[twining] /api/graph/summary error:", err);
        sendJSON(req, res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    if (route === "/api/graph/entities") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(req, res, { entities: [], total: 0, offset: 0 });
          return true;
        }

        const [entities, relations] = await Promise.all([
          graphStore.getEntities(),
          graphStore.getRelations(),
        ]);
        const degreeMap = buildDegreeMap(relations);

        const typeFilter = parsed.searchParams.get("type");
        const q = parsed.searchParams.get("q");
        const offsetParam = parseInt(parsed.searchParams.get("offset") ?? "", 10);
        const limitParam = parseInt(parsed.searchParams.get("limit") ?? "", 10);
        const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;
        const limit = Number.isFinite(limitParam) && limitParam >= 0 ? limitParam : DEFAULT_ENTITIES_LIMIT;

        let list = entities.map((e) => ({ id: e.id, name: e.name, type: e.type, degree: degreeMap.get(e.id) ?? 0 }));
        if (typeFilter) list = list.filter((e) => e.type === typeFilter);
        if (q) {
          const qLower = q.toLowerCase();
          list = list.filter((e) => e.name.toLowerCase().includes(qLower));
        }
        list.sort((a, b) => b.degree - a.degree || compareNames(a.name, b.name));

        const total = list.length;
        const paged = list.slice(offset, offset + limit);

        sendJSON(req, res, { entities: paged, total, offset });
      } catch (err) {
        console.error("[twining] /api/graph/entities error:", err);
        sendJSON(req, res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    return false;
  };
}
