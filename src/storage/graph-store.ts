/**
 * Knowledge graph storage layer.
 * Manages entities (upsert semantics) and relations with entity resolution.
 * Uses file-store readJSON/writeJSON with proper-lockfile for concurrent safety.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { LOCK_OPTIONS, atomicWriteFileSync, ensureFileExists } from "./file-store.js";
import { generateId } from "../utils/ids.js";
import { mergeRelationProperties } from "../utils/relation-properties.js";
import { mergeEntityProperties } from "../utils/entity-properties.js";
import type { Entity, Relation } from "../utils/types.js";

import { TwiningError } from "../utils/errors.js";
import type { IGraphStore } from "./interfaces.js";

export class GraphStore implements IGraphStore {
  /** Remove relations by id (wave-2 dedup pass). Unknown ids are ignored. */
  async removeRelations(relationIds: Set<string>): Promise<{ removed: number }> {
    this.ensureFiles();
    const release = await lockfile.lock(this.relationsPath, LOCK_OPTIONS);
    try {
      const relations = JSON.parse(
        fs.readFileSync(this.relationsPath, "utf-8"),
      ) as Relation[];
      const kept = relations.filter((r) => !relationIds.has(r.id));
      const removed = relations.length - kept.length;
      if (removed > 0) {
        atomicWriteFileSync(this.relationsPath, JSON.stringify(kept, null, 2));
      }
      return { removed };
    } finally {
      await release();
    }
  }

  private readonly entitiesPath: string;
  private readonly relationsPath: string;
  private readonly graphDir: string;

  constructor(twiningDir: string) {
    this.graphDir = path.join(twiningDir, "graph");
    this.entitiesPath = path.join(this.graphDir, "entities.json");
    this.relationsPath = path.join(this.graphDir, "relations.json");
  }

  /** Ensure graph directory and files exist. */
  private ensureFiles(): void {
    if (!fs.existsSync(this.graphDir)) {
      fs.mkdirSync(this.graphDir, { recursive: true });
    }
    ensureFileExists(this.entitiesPath, JSON.stringify([]));
    ensureFileExists(this.relationsPath, JSON.stringify([]));
  }

  /**
   * Add or update an entity.
   * Upsert: match by name+type. If found, merge properties and update timestamp.
   * If not found, create new entity with generated ID.
   */
  async addEntity(input: {
    name: string;
    type: Entity["type"];
    properties?: Record<string, string>;
  }): Promise<Entity> {
    this.ensureFiles();

    const release = await lockfile.lock(this.entitiesPath, LOCK_OPTIONS);
    try {
      const entities = JSON.parse(
        fs.readFileSync(this.entitiesPath, "utf-8"),
      ) as Entity[];

      const now = new Date().toISOString();
      const existing = entities.find(
        (e) => e.name === input.name && e.type === input.type,
      );

      if (existing) {
        // Upsert: merge properties and update timestamp. `scope` unions rather
        // than overwriting — see utils/entity-properties.ts.
        existing.properties = mergeEntityProperties(
          existing.properties,
          input.properties,
        );
        existing.updated_at = now;
        atomicWriteFileSync(
          this.entitiesPath,
          JSON.stringify(entities, null, 2),
        );
        return existing;
      }

      // Create new
      const entity: Entity = {
        id: generateId(),
        name: input.name,
        type: input.type,
        properties: input.properties ?? {},
        created_at: now,
        updated_at: now,
      };
      entities.push(entity);
      atomicWriteFileSync(
        this.entitiesPath,
        JSON.stringify(entities, null, 2),
      );
      return entity;
    } finally {
      await release();
    }
  }

  /**
   * Add a relation between two entities.
   * Source/target can be entity ID or name.
   * Resolves by ID first, then by name. Throws AMBIGUOUS_ENTITY if name matches multiple.
   */
  async addRelation(input: {
    source: string;
    target: string;
    type: Relation["type"];
    properties?: Record<string, string>;
  }): Promise<Relation> {
    this.ensureFiles();

    const entities = JSON.parse(
      fs.readFileSync(this.entitiesPath, "utf-8"),
    ) as Entity[];

    const resolveEntity = (ref: string): Entity => {
      // Try by ID first
      const byId = entities.find((e) => e.id === ref);
      if (byId) return byId;

      // Try by name
      const byName = entities.filter((e) => e.name === ref);
      if (byName.length === 0) {
        throw new TwiningError(
          `Entity not found: "${ref}"`,
          "NOT_FOUND",
        );
      }
      if (byName.length > 1) {
        const matches = byName.map((e) => `${e.name} (${e.type})`).join(", ");
        throw new TwiningError(
          `Ambiguous entity name "${ref}" matches: ${matches}`,
          "AMBIGUOUS_ENTITY",
        );
      }
      return byName[0]!;
    };

    const sourceEntity = resolveEntity(input.source);
    const targetEntity = resolveEntity(input.target);

    const release = await lockfile.lock(this.relationsPath, LOCK_OPTIONS);
    try {
      const relations = JSON.parse(
        fs.readFileSync(this.relationsPath, "utf-8"),
      ) as Relation[];

      // Upsert by (source, target, type), mirroring addEntity's name+type
      // upsert (wave C): append-only relations duplicated decided_by edges on
      // every re-record and made derivation passes non-idempotent. Properties
      // merge last-wins, matching entity semantics. Parity with the sqlite
      // backend is contractual.
      const existing = relations.find(
        (r) =>
          r.source === sourceEntity.id &&
          r.target === targetEntity.id &&
          r.type === input.type,
      );
      if (existing) {
        existing.properties = mergeRelationProperties(
          existing.properties,
          input.properties,
        );
        atomicWriteFileSync(
          this.relationsPath,
          JSON.stringify(relations, null, 2),
        );
        return existing;
      }

      const relation: Relation = {
        id: generateId(),
        source: sourceEntity.id,
        target: targetEntity.id,
        type: input.type,
        properties: input.properties ?? {},
        created_at: new Date().toISOString(),
      };
      relations.push(relation);
      atomicWriteFileSync(
        this.relationsPath,
        JSON.stringify(relations, null, 2),
      );
      return relation;
    } finally {
      await release();
    }
  }

  /** Get all entities. Returns [] if file doesn't exist. */
  async getEntities(): Promise<Entity[]> {
    if (!fs.existsSync(this.entitiesPath)) return [];
    return JSON.parse(
      fs.readFileSync(this.entitiesPath, "utf-8"),
    ) as Entity[];
  }

  /** Get all relations. Returns [] if file doesn't exist. */
  async getRelations(): Promise<Relation[]> {
    if (!fs.existsSync(this.relationsPath)) return [];
    return JSON.parse(
      fs.readFileSync(this.relationsPath, "utf-8"),
    ) as Relation[];
  }

  /** Find entity by ID. Returns undefined if not found. */
  async getEntityById(id: string): Promise<Entity | undefined> {
    const entities = await this.getEntities();
    return entities.find((e) => e.id === id);
  }

  /** Find entities by name, optionally filtered by type. */
  async getEntityByName(
    name: string,
    type?: string,
  ): Promise<Entity[]> {
    const entities = await this.getEntities();
    return entities.filter(
      (e) => e.name === name && (type === undefined || e.type === type),
    );
  }

  /**
   * Remove entities by ID, along with any relations that reference them.
   * Returns the count of removed entities and relations.
   */
  async removeEntities(
    entityIds: Set<string>,
  ): Promise<{ removedEntities: number; removedRelations: number }> {
    this.ensureFiles();

    let removedEntities = 0;
    let removedRelations = 0;

    // Lock both files — entities first, then relations
    const releaseEntities = await lockfile.lock(
      this.entitiesPath,
      LOCK_OPTIONS,
    );
    try {
      const entities = JSON.parse(
        fs.readFileSync(this.entitiesPath, "utf-8"),
      ) as Entity[];
      const before = entities.length;
      const kept = entities.filter((e) => !entityIds.has(e.id));
      removedEntities = before - kept.length;
      atomicWriteFileSync(
        this.entitiesPath,
        JSON.stringify(kept, null, 2),
      );
    } finally {
      await releaseEntities();
    }

    const releaseRelations = await lockfile.lock(
      this.relationsPath,
      LOCK_OPTIONS,
    );
    try {
      const relations = JSON.parse(
        fs.readFileSync(this.relationsPath, "utf-8"),
      ) as Relation[];
      const before = relations.length;
      const kept = relations.filter(
        (r) => !entityIds.has(r.source) && !entityIds.has(r.target),
      );
      removedRelations = before - kept.length;
      atomicWriteFileSync(
        this.relationsPath,
        JSON.stringify(kept, null, 2),
      );
    } finally {
      await releaseRelations();
    }

    return { removedEntities, removedRelations };
  }
}
