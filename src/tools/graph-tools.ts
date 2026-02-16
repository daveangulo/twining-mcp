/**
 * MCP tool handlers for knowledge graph operations.
 * Registers twining_add_entity, twining_add_relation, twining_neighbors, twining_graph_query.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphEngine } from "../engine/graph.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";

export function registerGraphTools(
  server: McpServer,
  engine: GraphEngine,
): void {
  // twining_add_entity — Add or update a knowledge graph entity
  server.registerTool(
    "twining_add_entity",
    {
      description:
        "Add or update a knowledge graph entity. Uses upsert semantics: if an entity with the same name and type exists, its properties are merged and updated. Returns the entity ID.",
      inputSchema: {
        name: z.string().describe("Entity name (e.g., class name, file path, concept)"),
        type: z
          .string()
          .describe(
            'Entity type: "module", "function", "class", "file", "concept", "pattern", "dependency", "api_endpoint"',
          ),
        properties: z
          .record(z.string())
          .optional()
          .describe("Key-value properties for this entity"),
      },
    },
    async (args) => {
      try {
        const entity = await engine.addEntity({
          name: args.name,
          type: args.type as Parameters<typeof engine.addEntity>[0]["type"],
          properties: args.properties,
        });
        return toolResult({ id: entity.id });
      } catch (e) {
        if (e instanceof TwiningError) {
          return toolError(e.message, e.code);
        }
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_add_relation — Add a relation between two entities
  server.registerTool(
    "twining_add_relation",
    {
      description:
        "Add a relation between two knowledge graph entities. Source and target can be entity IDs or names. Returns an error for ambiguous name matches.",
      inputSchema: {
        source: z
          .string()
          .describe("Source entity ID or name"),
        target: z
          .string()
          .describe("Target entity ID or name"),
        type: z
          .string()
          .describe(
            'Relation type: "depends_on", "implements", "decided_by", "affects", "tested_by", "calls", "imports", "related_to"',
          ),
        properties: z
          .record(z.string())
          .optional()
          .describe("Key-value properties for this relation"),
      },
    },
    async (args) => {
      try {
        const relation = await engine.addRelation({
          source: args.source,
          target: args.target,
          type: args.type as Parameters<typeof engine.addRelation>[0]["type"],
          properties: args.properties,
        });
        return toolResult({ id: relation.id });
      } catch (e) {
        if (e instanceof TwiningError) {
          return toolError(e.message, e.code);
        }
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_neighbors — Traverse neighbors from an entity
  server.registerTool(
    "twining_neighbors",
    {
      description:
        "Traverse the knowledge graph from an entity, returning neighbors up to a given depth (max 3). Supports filtering by relation type. Useful for understanding how entities connect.",
      inputSchema: {
        entity: z
          .string()
          .describe("Entity ID or name to start traversal from"),
        depth: z
          .number()
          .optional()
          .describe("Traversal depth (1-3, default: 1)"),
        relation_types: z
          .array(z.string())
          .optional()
          .describe("Filter to only these relation types"),
      },
    },
    async (args) => {
      try {
        const result = await engine.neighbors(
          args.entity,
          args.depth,
          args.relation_types,
        );
        return toolResult(result);
      } catch (e) {
        if (e instanceof TwiningError) {
          return toolError(e.message, e.code);
        }
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );

  // twining_graph_query — Search entities by substring
  server.registerTool(
    "twining_graph_query",
    {
      description:
        "Search the knowledge graph for entities by name or property substring match. Case-insensitive. Returns matching entities with their properties.",
      inputSchema: {
        query: z.string().describe("Substring to search for in entity names and properties"),
        entity_types: z
          .array(z.string())
          .optional()
          .describe("Filter to only these entity types"),
        limit: z
          .number()
          .optional()
          .describe("Maximum results to return (default: 10)"),
      },
    },
    async (args) => {
      try {
        const result = await engine.query(
          args.query,
          args.entity_types,
          args.limit,
        );
        return toolResult(result);
      } catch (e) {
        if (e instanceof TwiningError) {
          return toolError(e.message, e.code);
        }
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );
}
