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

  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> => {
    const url = req.url || "/";

    // GET /api/status
    if (url === "/api/status") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(res, {
            initialized: false,
            blackboard_entries: 0,
            active_decisions: 0,
            provisional_decisions: 0,
            graph_entities: 0,
            graph_relations: 0,
            last_activity: "none",
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

        sendJSON(res, {
          initialized: true,
          blackboard_entries,
          active_decisions,
          provisional_decisions,
          graph_entities,
          graph_relations,
          last_activity,
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
