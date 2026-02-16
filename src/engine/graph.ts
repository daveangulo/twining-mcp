/**
 * Knowledge graph engine.
 * Business logic for BFS neighbor traversal and substring entity queries.
 * Delegates storage operations to GraphStore.
 */
import type { GraphStore } from "../storage/graph-store.js";
import type { Entity, Relation } from "../utils/types.js";
import { TwiningError } from "../utils/errors.js";

/** Direction of relation relative to the center entity. */
export type RelationDirection = "outgoing" | "incoming";

/** A neighbor with its connecting relation and direction. */
export interface NeighborEntry {
  entity: Entity;
  relation: Relation;
  direction: RelationDirection;
}

/** Result from neighbors() traversal. */
export interface NeighborsResult {
  center: Entity;
  neighbors: NeighborEntry[];
}

/** Result from query() search. */
export interface QueryResult {
  entities: Entity[];
}

export class GraphEngine {
  private readonly graphStore: GraphStore;

  constructor(graphStore: GraphStore) {
    this.graphStore = graphStore;
  }

  /** Delegate entity creation/upsert to store. */
  async addEntity(input: {
    name: string;
    type: Entity["type"];
    properties?: Record<string, string>;
  }): Promise<Entity> {
    return this.graphStore.addEntity(input);
  }

  /** Delegate relation creation to store. */
  async addRelation(input: {
    source: string;
    target: string;
    type: Relation["type"];
    properties?: Record<string, string>;
  }): Promise<Relation> {
    return this.graphStore.addRelation(input);
  }

  /**
   * BFS neighbor traversal from a center entity.
   * Traverses both outgoing and incoming relations.
   * Depth is clamped to max 3.
   */
  async neighbors(
    entityIdOrName: string,
    depth?: number,
    relationTypes?: string[],
  ): Promise<NeighborsResult> {
    // Resolve center entity
    const center = await this.resolveEntity(entityIdOrName);
    if (!center) {
      throw new TwiningError(
        `Entity not found: "${entityIdOrName}"`,
        "NOT_FOUND",
      );
    }

    const maxDepth = Math.min(Math.max(depth ?? 1, 1), 3);
    const relations = await this.graphStore.getRelations();
    const entities = await this.graphStore.getEntities();

    // Build entity lookup map
    const entityMap = new Map<string, Entity>();
    for (const e of entities) {
      entityMap.set(e.id, e);
    }

    // Filter relations by type if specified
    const filteredRelations = relationTypes
      ? relations.filter((r) => relationTypes.includes(r.type))
      : relations;

    // Build adjacency list: entityId -> [{neighborId, relation, direction}]
    const adjacency = new Map<
      string,
      { neighborId: string; relation: Relation; direction: RelationDirection }[]
    >();

    for (const rel of filteredRelations) {
      // Outgoing: source -> target
      if (!adjacency.has(rel.source)) adjacency.set(rel.source, []);
      adjacency.get(rel.source)!.push({
        neighborId: rel.target,
        relation: rel,
        direction: "outgoing",
      });

      // Incoming: target -> source
      if (!adjacency.has(rel.target)) adjacency.set(rel.target, []);
      adjacency.get(rel.target)!.push({
        neighborId: rel.source,
        relation: rel,
        direction: "incoming",
      });
    }

    // BFS
    const visited = new Set<string>();
    visited.add(center.id);

    const result: NeighborEntry[] = [];
    let frontier = [center.id];

    for (let d = 0; d < maxDepth; d++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const neighbors = adjacency.get(nodeId) ?? [];
        for (const { neighborId, relation, direction } of neighbors) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            const entity = entityMap.get(neighborId);
            if (entity) {
              result.push({ entity, relation, direction });
              nextFrontier.push(neighborId);
            }
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return { center, neighbors: result };
  }

  /**
   * Substring search across entity names and property values.
   * Case-insensitive. Optionally filtered by entity types.
   */
  async query(
    queryStr: string,
    entityTypes?: string[],
    limit?: number,
  ): Promise<QueryResult> {
    const maxResults = limit ?? 10;
    const entities = await this.graphStore.getEntities();
    const lowerQuery = queryStr.toLowerCase();

    const matches = entities.filter((entity) => {
      // Filter by type if specified
      if (entityTypes && !entityTypes.includes(entity.type)) return false;

      // Check name
      if (entity.name.toLowerCase().includes(lowerQuery)) return true;

      // Check property values
      for (const value of Object.values(entity.properties)) {
        if (value.toLowerCase().includes(lowerQuery)) return true;
      }

      return false;
    });

    return { entities: matches.slice(0, maxResults) };
  }

  /** Resolve an entity by ID or name. Returns undefined if not found. */
  private async resolveEntity(
    idOrName: string,
  ): Promise<Entity | undefined> {
    // Try by ID first
    const byId = await this.graphStore.getEntityById(idOrName);
    if (byId) return byId;

    // Try by name (take first match)
    const byName = await this.graphStore.getEntityByName(idOrName);
    return byName[0];
  }
}
