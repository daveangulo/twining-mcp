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
import { HandoffStore } from "../storage/handoff-store.js";
import { scoreItem, buildProbes } from "../engine/staleness.js";
import { loadConfig } from "../config.js";
import type { DashboardDeps } from "./api-routes.js";
import type { IBlackboardStore, IDecisionStore, IGraphStore, IHandoffStore } from "../storage/interfaces.js";
import type { DecisionIndexEntry, Entity, Relation } from "../utils/types.js";

const SUMMARY_MAX = 120;
const HUB_LIMIT = 20;
const DEFAULT_ENTITIES_LIMIT = 50;
const DEFAULT_NEIGHBORHOOD_LIMIT = 150;
const HEALTH_LIST_CAP = 50;
const HEALTH_CACHE_TTL_MS = 60_000;

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

/** Whole days between an ISO timestamp and now. */
function ageDays(timestamp: string): number {
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / 86_400_000);
}

/**
 * Walk `superseded_by` links to find supersession chains of length >= 2.
 * Reads FULL decisions only for index entries with status === "superseded"
 * (bounded by that count, never the total decision count) since the link
 * field isn't carried on the lightweight index. A chain's "head" is its
 * terminal node (the most-current decision, which may itself be active and
 * not require a file read at all — its summary comes from the index).
 */
async function buildSupersededChains(
  decisionStore: IDecisionStore,
  index: DecisionIndexEntry[],
): Promise<Array<{ head_id: string; head_summary: string; length: number }>> {
  const supersededEntries = index.filter((e) => e.status === "superseded");
  if (supersededEntries.length === 0) return [];

  const summaryById = new Map(index.map((e) => [e.id, e.summary]));
  const linkMap = new Map<string, string>(); // id -> the decision that superseded it
  for (const entry of supersededEntries) {
    const decision = await decisionStore.get(entry.id);
    if (decision?.superseded_by) {
      linkMap.set(entry.id, decision.superseded_by);
    }
  }

  const supersededIds = new Set(supersededEntries.map((e) => e.id));
  const pointedTo = new Set(linkMap.values());
  // A chain root is a superseded decision nobody else's link points at —
  // i.e. the earliest link in its chain. Walking from every superseded
  // entry would report the same chain once per node.
  const roots = [...supersededIds].filter((id) => !pointedTo.has(id));

  const chains: Array<{ head_id: string; head_summary: string; length: number }> = [];
  for (const root of roots) {
    const visited = new Set<string>([root]);
    let current = root;
    while (linkMap.has(current)) {
      const next = linkMap.get(current)!;
      if (visited.has(next)) break; // cycle guard against malformed data
      visited.add(next);
      current = next;
    }
    if (visited.size < 2) continue;
    chains.push({
      head_id: current,
      head_summary: summaryById.get(current) ?? "",
      length: visited.size,
    });
  }

  chains.sort((a, b) => b.length - a.length || compareNames(a.head_id, b.head_id));
  return chains.slice(0, HEALTH_LIST_CAP);
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
  const handoffStore: IHandoffStore = deps?.handoffStore ?? new HandoffStore(twiningDir);

  // Whole computed report, cached for HEALTH_CACHE_TTL_MS — chain-building
  // reads O(superseded) decision files and staleness scoring walks every
  // decision's scope/affected_files on disk, so this must not run per poll.
  let healthReportCache: { at: number; body: unknown } | null = null;

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

    if (route === "/api/graph/neighborhood") {
      try {
        const anchorId = parsed.searchParams.get("id");
        if (!anchorId) {
          sendJSON(req, res, { error: "id query parameter required" }, 400);
          return true;
        }

        if (!fs.existsSync(twiningDir)) {
          sendJSON(req, res, { error: "Entity not found" }, 404);
          return true;
        }

        const [entities, relations] = await Promise.all([
          graphStore.getEntities(),
          graphStore.getRelations(),
        ]);
        const entityById = new Map(entities.map((e) => [e.id, e]));
        const anchorEntity = entityById.get(anchorId);
        if (!anchorEntity) {
          sendJSON(req, res, { error: "Entity not found" }, 404);
          return true;
        }

        const degreeMap = buildDegreeMap(relations);

        // Adjacency built once per request: entity id -> relations touching it.
        const adjacency = new Map<string, Relation[]>();
        for (const r of relations) {
          if (!adjacency.has(r.source)) adjacency.set(r.source, []);
          adjacency.get(r.source)!.push(r);
          if (r.source !== r.target) {
            if (!adjacency.has(r.target)) adjacency.set(r.target, []);
            adjacency.get(r.target)!.push(r);
          }
        }

        /** Entities on the other end of any relation touching nodeId, deduped, sorted (degree desc, name asc). */
        function neighborsOf(nodeId: string): Entity[] {
          const rels = adjacency.get(nodeId) ?? [];
          const seen = new Set<string>();
          const result: Entity[] = [];
          for (const r of rels) {
            const otherId = r.source === nodeId ? r.target : r.source;
            if (otherId === nodeId || seen.has(otherId)) continue;
            seen.add(otherId);
            const e = entityById.get(otherId);
            if (e) result.push(e);
          }
          result.sort((a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0) || compareNames(a.name, b.name));
          return result;
        }

        const toEntityOut = (e: Entity) => ({ id: e.id, name: e.name, type: e.type, degree: degreeMap.get(e.id) ?? 0 });
        const toRelationOut = (r: Relation) => ({ id: r.id, source: r.source, target: r.target, type: r.type });

        const typeParam = parsed.searchParams.get("type");
        if (typeParam !== null) {
          // Overflow-paging variant: sorted neighbors of anchor filtered to
          // `type`, sliced offset..offset+limit.
          const offsetParam = parseInt(parsed.searchParams.get("offset") ?? "", 10);
          const limitParam = parseInt(parsed.searchParams.get("limit") ?? "", 10);
          const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;
          const limit = Number.isFinite(limitParam) && limitParam >= 0 ? limitParam : DEFAULT_ENTITIES_LIMIT;

          const filtered = neighborsOf(anchorId).filter((e) => e.type === typeParam);
          const total_of_type = filtered.length;
          const page = filtered.slice(offset, offset + limit);
          const pageIds = new Set(page.map((e) => e.id));
          const relOut = relations
            .filter((r) => (r.source === anchorId && pageIds.has(r.target)) || (r.target === anchorId && pageIds.has(r.source)))
            .map(toRelationOut);

          sendJSON(req, res, {
            anchor: anchorId,
            entities: page.map(toEntityOut),
            relations: relOut,
            total_of_type,
          });
          return true;
        }

        // depth/limit ego-network variant.
        const depthParam = parsed.searchParams.get("depth");
        let depth = 1;
        if (depthParam !== null) {
          const d = parseInt(depthParam, 10);
          if (d !== 1 && d !== 2) {
            sendJSON(req, res, { error: "depth must be 1 or 2" }, 400);
            return true;
          }
          depth = d;
        }
        const limitParam = parseInt(parsed.searchParams.get("limit") ?? "", 10);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_NEIGHBORHOOD_LIMIT;

        const includedIds = new Set<string>([anchorId]);
        const orderedIncluded: Entity[] = [anchorEntity];
        const overflow: Array<{ from: string; type: string; omitted: number }> = [];
        let budget = limit - 1; // excludes anchor

        // Depth 1: group anchor's neighbors by type, round-robin across
        // type groups (alphabetical) taking the best remaining candidate
        // from each non-empty group until budget or groups are exhausted.
        const anchorNeighbors = neighborsOf(anchorId);
        const byType = new Map<string, Entity[]>();
        for (const e of anchorNeighbors) {
          if (!byType.has(e.type)) byType.set(e.type, []);
          byType.get(e.type)!.push(e);
        }
        const typeKeysSorted = [...byType.keys()].sort(compareNames);
        const cursors = new Map<string, number>(typeKeysSorted.map((t) => [t, 0]));
        const depth1Chosen: Entity[] = [];

        let progressed = budget > 0 && typeKeysSorted.length > 0;
        while (progressed) {
          progressed = false;
          for (const t of typeKeysSorted) {
            if (budget <= 0) break;
            const idx = cursors.get(t)!;
            const list = byType.get(t)!;
            const candidate = list[idx];
            if (candidate) {
              cursors.set(t, idx + 1);
              if (!includedIds.has(candidate.id)) {
                includedIds.add(candidate.id);
                orderedIncluded.push(candidate);
                depth1Chosen.push(candidate);
              }
              budget--;
              progressed = true;
            }
          }
        }
        for (const t of typeKeysSorted) {
          const idx = cursors.get(t)!;
          const omitted = byType.get(t)!.length - idx;
          if (omitted > 0) overflow.push({ from: anchorId, type: t, omitted });
        }

        // Depth 2: with remaining budget, walk chosen depth-1 nodes in
        // (degree desc, name asc) order, adding not-yet-included neighbors
        // (same sort) until budget is exhausted.
        if (depth === 2 && budget > 0) {
          const walkOrder = [...depth1Chosen].sort(
            (a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0) || compareNames(a.name, b.name),
          );
          for (const node of walkOrder) {
            if (budget <= 0) break;
            const candidates = neighborsOf(node.id).filter((e) => !includedIds.has(e.id));
            let added = 0;
            for (const c of candidates) {
              if (budget <= 0) break;
              includedIds.add(c.id);
              orderedIncluded.push(c);
              budget--;
              added++;
            }
            // Cut candidates may span multiple entity types (unlike the
            // depth-1 phase, which walks pre-grouped type buckets) — group
            // the leftover by type so every overflow entry carries `type`.
            const cut = candidates.slice(added);
            if (cut.length > 0) {
              const cutByType = new Map<string, number>();
              for (const c of cut) cutByType.set(c.type, (cutByType.get(c.type) ?? 0) + 1);
              for (const t of [...cutByType.keys()].sort(compareNames)) {
                overflow.push({ from: node.id, type: t, omitted: cutByType.get(t)! });
              }
            }
          }
        }

        const relOut = relations
          .filter((r) => includedIds.has(r.source) && includedIds.has(r.target))
          .map(toRelationOut);

        sendJSON(req, res, {
          anchor: anchorId,
          entities: orderedIncluded.map(toEntityOut),
          relations: relOut,
          overflow,
        });
      } catch (err) {
        console.error("[twining] /api/graph/neighborhood error:", err);
        sendJSON(req, res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    if (route === "/api/health-report") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(req, res, {
            stale_decisions: [], unresolved_warnings: [], superseded_chains: [],
            orphan_entities: { count: 0, sample: [] }, unacknowledged_handoffs: [],
            generated_at: new Date().toISOString(),
          });
          return true;
        }

        const now = Date.now();
        if (healthReportCache && now - healthReportCache.at < HEALTH_CACHE_TTL_MS) {
          sendJSON(req, res, healthReportCache.body);
          return true;
        }

        const config = loadConfig(twiningDir);
        const threshold = config.housekeeping?.staleness_threshold ?? 0.95;

        const [decIndex, { entries: warningEntries }, entities, relations, handoffEntries] = await Promise.all([
          decisionStore.getIndex(),
          blackboardStore.read({ entry_types: ["warning"] }),
          graphStore.getEntities(),
          graphStore.getRelations(),
          handoffStore.list({}),
        ]);

        // Stale decisions: score against the lightweight index, not full
        // decision files — O(fs.existsSync calls) rather than O(full-file
        // reads) across every decision. Trades away the branch_gone signal
        // for decisions (provenance isn't carried on the index entry);
        // scope/affected_files checks are the common case and this must run
        // over the whole decision set on every cache miss.
        const probes = buildProbes(projectRoot);
        const staleDecisions = decIndex
          .map((d) => {
            const { score, reasons } = scoreItem(
              { scope: d.scope, affected_files: d.affected_files },
              probes,
            );
            return { id: d.id, summary: d.summary, scope: d.scope, score, reasons: reasons.map((r) => r.detail) };
          })
          .filter((d) => d.score >= threshold && d.reasons.length > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, HEALTH_LIST_CAP);

        const unresolvedWarnings = warningEntries
          .slice()
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .slice(0, HEALTH_LIST_CAP)
          .map((e) => ({ id: e.id, summary: e.summary, scope: e.scope, age_days: ageDays(e.timestamp) }));

        const supersededChains = await buildSupersededChains(decisionStore, decIndex);

        const degreeMap = buildDegreeMap(relations);
        const orphanEntities = entities
          .filter((e) => (degreeMap.get(e.id) ?? 0) === 0)
          .sort((a, b) => compareNames(a.name, b.name));
        const orphanSample = orphanEntities
          .slice(0, HEALTH_LIST_CAP)
          .map((e) => ({ id: e.id, name: e.name, type: e.type }));

        const unacknowledgedHandoffs = handoffEntries
          .filter((h) => !h.acknowledged)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, HEALTH_LIST_CAP)
          .map((h) => ({ id: h.id, summary: h.summary, age_days: ageDays(h.created_at) }));

        const body = {
          stale_decisions: staleDecisions,
          unresolved_warnings: unresolvedWarnings,
          superseded_chains: supersededChains,
          orphan_entities: { count: orphanEntities.length, sample: orphanSample },
          unacknowledged_handoffs: unacknowledgedHandoffs,
          generated_at: new Date().toISOString(),
        };

        healthReportCache = { at: now, body };
        sendJSON(req, res, body);
      } catch (err) {
        console.error("[twining] /api/health-report error:", err);
        sendJSON(req, res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    return false;
  };
}
