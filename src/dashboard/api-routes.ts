/**
 * Dashboard API route handlers.
 *
 * Factory function creates a request handler that serves JSON endpoints
 * for blackboard entries, decisions, graph data, and operational status.
 *
 * CRITICAL: Never use console.log or process.stdout in this module.
 * The MCP StdioServerTransport owns stdout exclusively.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import { AgentStore } from "../storage/agent-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import { BlackboardEngine } from "../engine/blackboard.js";
import { DecisionEngine } from "../engine/decisions.js";
import { GraphEngine } from "../engine/graph.js";
import { Embedder } from "../embeddings/embedder.js";
import { IndexManager } from "../embeddings/index-manager.js";
import { SearchEngine } from "../embeddings/search.js";
import {
  scoreAgent,
  parseDelegationMetadata,
  isDelegationExpired,
} from "../engine/coordination.js";
import {
  computeLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
} from "../utils/liveness.js";

/** Send a JSON response with standard headers. */
function sendJSON(
  res: http.ServerResponse,
  data: unknown,
  statusCode: number = 200,
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

/**
 * Create an API request handler for the given project root.
 *
 * Returns an async function that handles /api/* routes and returns true
 * if the request was handled, false if it should fall through to other
 * handlers (e.g., static file serving).
 *
 * Store instances are created once in the closure, not per-request.
 */
export function createApiHandler(
  projectRoot: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const twiningDir = path.join(projectRoot, ".twining");
  const blackboardStore = new BlackboardStore(twiningDir);
  const decisionStore = new DecisionStore(twiningDir);
  const graphStore = new GraphStore(twiningDir);
  const agentStore = new AgentStore(twiningDir);
  const handoffStore = new HandoffStore(twiningDir);

  // Engine layer for search — lazily initialized to avoid creating
  // .twining/embeddings/ directory on uninitialized projects
  let searchEngines: {
    blackboardEngine: BlackboardEngine;
    decisionEngine: DecisionEngine;
    graphEngine: GraphEngine;
  } | null = null;

  function getSearchEngines() {
    if (!searchEngines) {
      const embedder = Embedder.getInstance(twiningDir);
      const indexManager = new IndexManager(twiningDir);
      const searchEngine = new SearchEngine(embedder, indexManager);
      const bbEngine = new BlackboardEngine(
        blackboardStore,
        embedder,
        indexManager,
        searchEngine,
      );
      const decEngine = new DecisionEngine(
        decisionStore,
        bbEngine,
        embedder,
        indexManager,
        projectRoot,
        searchEngine,
      );
      const grEngine = new GraphEngine(graphStore);
      searchEngines = {
        blackboardEngine: bbEngine,
        decisionEngine: decEngine,
        graphEngine: grEngine,
      };
    }
    return searchEngines;
  }

  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> => {
    const url = req.url || "/";

    // GET /api/search?q=...
    if (url.startsWith("/api/search")) {
      try {
        if (!fs.existsSync(twiningDir)) {
          const parsed = new URL(url, "http://localhost");
          sendJSON(res, {
            query: parsed.searchParams.get("q") || "",
            results: [],
            total: 0,
            fallback_mode: true,
          });
          return true;
        }

        const parsed = new URL(url, "http://localhost");
        const q = parsed.searchParams.get("q") || "";
        const typesParam = parsed.searchParams.get("types");
        const scope = parsed.searchParams.get("scope");
        const status = parsed.searchParams.get("status");
        const domain = parsed.searchParams.get("domain");
        const confidence = parsed.searchParams.get("confidence");
        const tagsParam = parsed.searchParams.get("tags");
        const since = parsed.searchParams.get("since");
        const until = parsed.searchParams.get("until");
        const limitParam = parsed.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam, 10) : 20;

        if (!q) {
          sendJSON(res, {
            query: "",
            results: [],
            total: 0,
            fallback_mode: true,
          });
          return true;
        }

        const requestedTypes = typesParam
          ? typesParam.split(",").map((t) => t.trim())
          : ["blackboard", "decisions", "entities"];
        const tags = tagsParam
          ? tagsParam.split(",").map((t) => t.trim())
          : null;

        interface UnifiedResult {
          type: string;
          id: string;
          summary?: string;
          name?: string;
          scope?: string;
          domain?: string;
          status?: string;
          confidence?: string;
          entity_type?: string;
          entry_type?: string;
          properties?: Record<string, string>;
          timestamp?: string;
          relevance: number;
        }

        const engines = getSearchEngines();
        const allResults: UnifiedResult[] = [];
        let fallbackMode = true;

        // Search blackboard
        if (requestedTypes.includes("blackboard")) {
          const bbResult = await engines.blackboardEngine.query(q, { limit });
          if (!bbResult.fallback_mode) {
            fallbackMode = false;
          }
          for (const r of bbResult.results) {
            const entry = r.entry;
            // Post-filter by scope
            if (scope && !entry.scope.startsWith(scope)) continue;
            // Post-filter by tags
            if (tags && !tags.some((t) => entry.tags.includes(t))) continue;
            // Post-filter by since/until
            if (since && entry.timestamp < since) continue;
            if (until && entry.timestamp > until) continue;

            allResults.push({
              type: "blackboard",
              id: entry.id,
              summary: entry.summary,
              scope: entry.scope,
              timestamp: entry.timestamp,
              entry_type: entry.entry_type,
              relevance: r.relevance,
            });
          }
        }

        // Search decisions
        if (requestedTypes.includes("decisions")) {
          const decResult = await engines.decisionEngine.searchDecisions(
            q,
            {
              domain: domain || undefined,
              status: (status as "active" | "provisional" | "superseded" | "overridden") || undefined,
              confidence: (confidence as "high" | "medium" | "low") || undefined,
            },
            limit,
          );
          for (const r of decResult.results) {
            // Post-filter by scope
            if (scope && !r.scope.startsWith(scope)) continue;
            // Post-filter by since/until
            if (since && r.timestamp < since) continue;
            if (until && r.timestamp > until) continue;

            allResults.push({
              type: "decision",
              id: r.id,
              summary: r.summary,
              scope: r.scope,
              domain: r.domain,
              status: r.status,
              confidence: r.confidence,
              timestamp: r.timestamp,
              relevance: r.relevance,
            });
          }
        }

        // Search entities
        if (requestedTypes.includes("entities")) {
          const entResult = await engines.graphEngine.query(q, undefined, limit);
          for (const entity of entResult.entities) {
            allResults.push({
              type: "entity",
              id: entity.id,
              name: entity.name,
              entity_type: entity.type,
              properties: entity.properties,
              relevance: 0.5,
            });
          }
        }

        // Sort by relevance descending, then timestamp descending as tiebreaker
        allResults.sort((a, b) => {
          if (b.relevance !== a.relevance) return b.relevance - a.relevance;
          const aTime = a.timestamp || "";
          const bTime = b.timestamp || "";
          return bTime.localeCompare(aTime);
        });

        sendJSON(res, {
          query: q,
          results: allResults,
          total: allResults.length,
          fallback_mode: fallbackMode,
        });
      } catch (err: unknown) {
        console.error("[twining] API /api/search error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/status
    if (url === "/api/status") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, {
            initialized: false,
            project_name: path.basename(projectRoot),
            blackboard_entries: 0,
            active_decisions: 0,
            provisional_decisions: 0,
            graph_entities: 0,
            graph_relations: 0,
            last_activity: "none",
            registered_agents: 0,
            active_agents: 0,
            pending_delegations: 0,
            total_handoffs: 0,
          });
          return true;
        }

        const { total_count: blackboard_entries } =
          await blackboardStore.read();

        const index = await decisionStore.getIndex();
        const active_decisions = index.filter(
          (e) => e.status === "active",
        ).length;
        const provisional_decisions = index.filter(
          (e) => e.status === "provisional",
        ).length;

        const entities = await graphStore.getEntities();
        const relations = await graphStore.getRelations();
        const graph_entities = entities.length;
        const graph_relations = relations.length;

        // Compute last_activity from most recent blackboard entry and decision
        const recentEntries = await blackboardStore.recent(1);
        const lastBBActivity =
          recentEntries.length > 0
            ? recentEntries[recentEntries.length - 1]!.timestamp
            : null;
        const lastDecisionActivity =
          index.length > 0
            ? index.reduce(
                (latest, e) =>
                  e.timestamp > latest ? e.timestamp : latest,
                index[0]!.timestamp,
              )
            : null;

        let last_activity = "none";
        if (lastBBActivity && lastDecisionActivity) {
          last_activity =
            lastBBActivity > lastDecisionActivity
              ? lastBBActivity
              : lastDecisionActivity;
        } else if (lastBBActivity) {
          last_activity = lastBBActivity;
        } else if (lastDecisionActivity) {
          last_activity = lastDecisionActivity;
        }

        // Coordination counts
        const agents = await agentStore.getAll();
        const registered_agents = agents.length;
        const now = new Date();
        const active_agents = agents.filter(
          (a) =>
            computeLiveness(a.last_active, now, DEFAULT_LIVENESS_THRESHOLDS) ===
            "active",
        ).length;

        const { entries: needEntries } = await blackboardStore.read({
          entry_types: ["need"],
        });
        const pending_delegations = needEntries.filter((entry) => {
          const meta = parseDelegationMetadata(entry);
          return meta !== null && !isDelegationExpired(meta, now);
        }).length;

        const handoffs = await handoffStore.list({});
        const total_handoffs = handoffs.length;

        sendJSON(res, {
          initialized: true,
          project_name: path.basename(projectRoot),
          blackboard_entries,
          active_decisions,
          provisional_decisions,
          graph_entities,
          graph_relations,
          last_activity,
          registered_agents,
          active_agents,
          pending_delegations,
          total_handoffs,
        });
      } catch (err: unknown) {
        console.error("[twining] API /api/status error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/blackboard
    if (url === "/api/blackboard") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, {
            initialized: false,
            entries: [],
            total_count: 0,
          });
          return true;
        }

        const { entries, total_count } = await blackboardStore.read();
        sendJSON(res, { initialized: true, entries, total_count });
      } catch (err: unknown) {
        console.error("[twining] API /api/blackboard error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/decisions/:id (must come before /api/decisions exact match)
    if (url.startsWith("/api/decisions/")) {
      try {
        const id = url.slice("/api/decisions/".length);
        if (!id) {
          sendJSON(res, { error: "Decision ID required" }, 400);
          return true;
        }

        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, { error: "Decision not found" }, 404);
          return true;
        }

        const decision = await decisionStore.get(id);
        if (!decision) {
          sendJSON(res, { error: "Decision not found" }, 404);
          return true;
        }

        sendJSON(res, decision);
      } catch (err: unknown) {
        console.error("[twining] API /api/decisions/:id error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/decisions
    if (url === "/api/decisions") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, {
            initialized: false,
            decisions: [],
            total_count: 0,
          });
          return true;
        }

        const decisions = await decisionStore.getIndex();
        sendJSON(res, {
          initialized: true,
          decisions,
          total_count: decisions.length,
        });
      } catch (err: unknown) {
        console.error("[twining] API /api/decisions error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/agents
    if (url === "/api/agents") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, { initialized: false, agents: [], total: 0 });
          return true;
        }

        const agents = await agentStore.getAll();
        const now = new Date();
        const mapped = agents.map((agent) => ({
          ...agent,
          liveness: computeLiveness(
            agent.last_active,
            now,
            DEFAULT_LIVENESS_THRESHOLDS,
          ),
        }));
        sendJSON(res, { initialized: true, agents: mapped, total: mapped.length });
      } catch (err: unknown) {
        console.error("[twining] API /api/agents error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/delegations
    if (url === "/api/delegations") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, { initialized: false, delegations: [], total: 0 });
          return true;
        }

        const { entries: needEntries } = await blackboardStore.read({
          entry_types: ["need"],
        });
        const agents = await agentStore.getAll();
        const now = new Date();

        const delegations: Array<{
          entry_id: string;
          timestamp: string;
          summary: string;
          scope: string;
          agent_id: string;
          required_capabilities: string[];
          urgency: string;
          expires_at: string;
          expired: boolean;
          suggested_agents: Array<{
            agent_id: string;
            capabilities: string[];
            role?: string;
            liveness: string;
            total_score: number;
          }>;
        }> = [];

        for (const entry of needEntries) {
          const meta = parseDelegationMetadata(entry);
          if (!meta) continue;

          const expired = isDelegationExpired(meta, now);

          // Score agents, filter out gone, sort by total_score, take top 5
          const scored = agents
            .map((agent) =>
              scoreAgent(
                agent,
                meta.required_capabilities,
                DEFAULT_LIVENESS_THRESHOLDS,
                now,
              ),
            )
            .filter((s) => s.liveness !== "gone")
            .sort((a, b) => b.total_score - a.total_score)
            .slice(0, 5)
            .map((s) => ({
              agent_id: s.agent_id,
              capabilities: s.capabilities,
              role: s.role,
              liveness: s.liveness,
              total_score: s.total_score,
            }));

          delegations.push({
            entry_id: entry.id,
            timestamp: entry.timestamp,
            summary: entry.summary,
            scope: entry.scope,
            agent_id: entry.agent_id,
            required_capabilities: meta.required_capabilities,
            urgency: meta.urgency,
            expires_at: meta.expires_at,
            expired,
            suggested_agents: scored,
          });
        }

        sendJSON(res, {
          initialized: true,
          delegations,
          total: delegations.length,
        });
      } catch (err: unknown) {
        console.error("[twining] API /api/delegations error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/handoffs/:id (must come before /api/handoffs exact match)
    if (url.startsWith("/api/handoffs/")) {
      try {
        const id = url.slice("/api/handoffs/".length);
        if (!id) {
          sendJSON(res, { error: "Handoff ID required" }, 400);
          return true;
        }

        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, { error: "Handoff not found" }, 404);
          return true;
        }

        const handoff = await handoffStore.get(id);
        if (!handoff) {
          sendJSON(res, { error: "Handoff not found" }, 404);
          return true;
        }

        sendJSON(res, handoff);
      } catch (err: unknown) {
        console.error("[twining] API /api/handoffs/:id error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/handoffs
    if (url === "/api/handoffs") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, { initialized: false, handoffs: [], total: 0 });
          return true;
        }

        const entries = await handoffStore.list({});
        sendJSON(res, {
          initialized: true,
          handoffs: entries,
          total: entries.length,
        });
      } catch (err: unknown) {
        console.error("[twining] API /api/handoffs error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // GET /api/graph
    if (url === "/api/graph") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, {
            initialized: false,
            entities: [],
            relations: [],
            entity_count: 0,
            relation_count: 0,
          });
          return true;
        }

        const entities = await graphStore.getEntities();
        const relations = await graphStore.getRelations();
        sendJSON(res, {
          initialized: true,
          entities,
          relations,
          entity_count: entities.length,
          relation_count: relations.length,
        });
      } catch (err: unknown) {
        console.error("[twining] API /api/graph error:", err);
        sendJSON(res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    // Not an API route we handle
    return false;
  };
}
