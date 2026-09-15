/**
 * Knowledge-graph commands: twining_add_entity, twining_add_relation,
 * twining_neighbors, twining_graph_query, twining_prune_graph.
 * Extracted verbatim from src/tools/graph-tools.ts.
 */
import { z } from "zod";
import type { GraphEngine } from "../../engine/graph.js";
import { commandFactory, type CommandDef } from "../command-def.js";

export interface GraphCtx {
  graphEngine: GraphEngine;
}

const { define } = commandFactory<GraphCtx>();

export const graphCommands: CommandDef<GraphCtx>[] = [
  define({
    name: "twining_add_entity",
    surface: "default",
    description:
      "Add or update a knowledge graph entity. Uses upsert semantics: if an entity with the same name and type exists, its properties are merged and updated. Returns the entity ID.",
    input: {
      name: z.string().describe("Entity name (e.g., class name, file path, concept)"),
      type: z
        .string()
        .describe(
          'Entity type: "module", "function", "class", "file", "concept", "pattern", "dependency", "api_endpoint"',
        ),
      properties: z
        .record(z.string().max(1000))
        .optional()
        .refine(
          (obj) => obj === undefined || Object.keys(obj).length <= 50,
          { message: "Maximum 50 properties per entity" },
        )
        .describe("Key-value properties for this entity (max 50 entries, values ≤1000 chars)"),
    },
    async handler(ctx, args) {
      const entity = await ctx.graphEngine.addEntity({
        name: args.name,
        type: args.type as Parameters<GraphEngine["addEntity"]>[0]["type"],
        properties: args.properties,
      });
      return { id: entity.id };
    },
  }),

  define({
    name: "twining_add_relation",
    surface: "default",
    description:
      "Add a relation between two knowledge graph entities. Source and target can be entity IDs or names. Returns an error for ambiguous name matches. Upsert semantics: re-adding the same (source, target, type) merges properties instead of duplicating the edge. Relations are provenance-marked: agent-typed edges get properties.origin \"declared\", auto-populated edges \"derived\", absent means legacy/unknown.",
    input: {
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
        .record(z.string().max(1000))
        .optional()
        .refine(
          (obj) => obj === undefined || Object.keys(obj).length <= 50,
          { message: "Maximum 50 properties per relation" },
        )
        .describe("Key-value properties for this relation (max 50 entries, values ≤1000 chars)"),
    },
    async handler(ctx, args) {
      // Provenance marker (field D13 ask 4): agent-typed = declared; a
      // caller-supplied origin wins (spread order).
      const relation = await ctx.graphEngine.addRelation({
        source: args.source,
        target: args.target,
        type: args.type as Parameters<GraphEngine["addRelation"]>[0]["type"],
        properties: { origin: "declared", ...(args.properties ?? {}) },
      });
      return { id: relation.id };
    },
  }),

  define({
    name: "twining_neighbors",
    surface: "default",
    description:
      "Traverse the knowledge graph from an entity, returning neighbors up to a given depth (max 3). Supports filtering by relation type. Useful for understanding how entities connect.",
    input: {
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
    async handler(ctx, args) {
      return await ctx.graphEngine.neighbors(
        args.entity,
        args.depth,
        args.relation_types,
      );
    },
  }),

  define({
    name: "twining_graph_query",
    surface: "default",
    description:
      "Search the knowledge graph for entities by name or property substring match. Case-insensitive. Returns matching entities with their properties.",
    input: {
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
    async handler(ctx, args) {
      return await ctx.graphEngine.query(
        args.query,
        args.entity_types,
        args.limit,
      );
    },
  }),

  define({
    name: "twining_prune_graph",
    surface: "default",
    description:
      "Remove orphaned knowledge graph entities that have no relations. Use this to clean up stale or disconnected entities. Optionally filter by entity type to only prune certain kinds.",
    input: {
      entity_types: z
        .array(z.string())
        .optional()
        .describe(
          'Only prune orphans of these types (e.g., ["concept", "file"]). If omitted, prunes all orphan types.',
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "If true, report orphans without removing them (default: false)",
        ),
    },
    async handler(ctx, args) {
      return await ctx.graphEngine.prune(
        args.entity_types,
        args.dry_run ?? false,
      );
    },
  }),
];
