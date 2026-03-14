/**
 * GraphAutoPopulator — auto-extracts entities and relations from tool calls.
 * Each method is independently try/catch wrapped — failures are logged but never propagated.
 * The graph is an optimization layer, not a correctness requirement.
 */
import type { GraphEngine } from "./graph.js";
import type { BlackboardEntry, Entity, Relation } from "../utils/types.js";

/** Determine if a scope looks like a file path (contains / and has a file extension). */
function isFileLikeScope(scope: string): boolean {
  return scope.includes("/") && /\.\w+$/.test(scope);
}

/** Determine if a scope looks like a directory (ends with / or has no extension). */
function isDirectoryLikeScope(scope: string): boolean {
  return scope.includes("/") && !isFileLikeScope(scope);
}

export class GraphAutoPopulator {
  constructor(private readonly graphEngine: GraphEngine) {}

  /**
   * Auto-populate from twining_decide.
   * Creates: concept entity for decision, file entities for affected_files,
   * function entities for affected_symbols, decided_by relations,
   * depends_on relations, supersedes relation, commit entity.
   */
  async onDecide(
    input: {
      affected_files?: string[];
      affected_symbols?: string[];
      depends_on?: string[];
      supersedes?: string;
      commit_hash?: string;
      scope: string;
      summary: string;
    },
    decisionId: string,
  ): Promise<void> {
    try {
      // Create concept entity for the decision itself
      const decisionEntity = await this.graphEngine.addEntity({
        name: decisionId,
        type: "concept",
        properties: { summary: input.summary, scope: input.scope },
      });

      // File entities with decided_by relations
      for (const filePath of input.affected_files ?? []) {
        const entity = await this.graphEngine.addEntity({
          name: filePath,
          type: "file",
          properties: { scope: input.scope },
        });
        await this.graphEngine.addRelation({
          source: entity.name,
          target: decisionEntity.name,
          type: "decided_by",
          properties: { decision_summary: input.summary },
        });
      }

      // Symbol entities with decided_by relations
      for (const symbol of input.affected_symbols ?? []) {
        const entity = await this.graphEngine.addEntity({
          name: symbol,
          type: "function",
          properties: { scope: input.scope },
        });
        await this.graphEngine.addRelation({
          source: entity.name,
          target: decisionEntity.name,
          type: "decided_by",
          properties: { decision_summary: input.summary },
        });
      }

      // depends_on relations between decision concept nodes
      for (const depId of input.depends_on ?? []) {
        await this.graphEngine.addRelation({
          source: decisionId,
          target: depId,
          type: "depends_on",
        });
      }

      // supersedes relation
      if (input.supersedes) {
        await this.graphEngine.addRelation({
          source: decisionId,
          target: input.supersedes,
          type: "supersedes",
        });
      }

      // commit entity with decided_by relation
      if (input.commit_hash) {
        await this.graphEngine.addEntity({
          name: input.commit_hash,
          type: "commit",
          properties: { decision: decisionId },
        });
        await this.graphEngine.addRelation({
          source: input.commit_hash,
          target: decisionId,
          type: "decided_by",
        });
      }
    } catch (error) {
      console.error("[twining] GraphAutoPopulator.onDecide failed (non-fatal):", error);
    }
  }

  /**
   * Auto-populate from twining_post.
   * Creates scope entities (file or module), relates_to relations,
   * affects relations for warnings and findings.
   */
  async onPost(entry: BlackboardEntry): Promise<void> {
    try {
      const scope = entry.scope;
      if (!scope || scope === "project") return;

      // Create scope entity
      let scopeEntity: Entity | undefined;
      if (isFileLikeScope(scope)) {
        scopeEntity = await this.graphEngine.addEntity({
          name: scope,
          type: "file",
          properties: { entry_type: entry.entry_type },
        });
      } else if (isDirectoryLikeScope(scope)) {
        scopeEntity = await this.graphEngine.addEntity({
          name: scope,
          type: "module",
          properties: { entry_type: entry.entry_type },
        });
      }

      if (!scopeEntity) return;

      // Warning or finding → affects relation
      if (entry.entry_type === "warning" || entry.entry_type === "finding") {
        // Create a concept entity for the warning/finding
        const conceptEntity = await this.graphEngine.addEntity({
          name: `${entry.entry_type}:${entry.id}`,
          type: "concept",
          properties: { summary: entry.summary, entry_type: entry.entry_type },
        });
        await this.graphEngine.addRelation({
          source: conceptEntity.name,
          target: scopeEntity.name,
          type: "affects",
          properties: { summary: entry.summary },
        });
      }

      // relates_to → related_to relations between scope entities
      if (entry.relates_to && entry.relates_to.length > 0) {
        // We create related_to relations from this entry's scope to related entries' scopes
        // We can't look up the related entries here (no blackboard access), but we create
        // relations using the entry IDs as potential entity names
        for (const relatedId of entry.relates_to) {
          await this.graphEngine.addRelation({
            source: scopeEntity.name,
            target: relatedId,
            type: "related_to",
            properties: { via: entry.id },
          });
        }
      }
    } catch (error) {
      console.error("[twining] GraphAutoPopulator.onPost failed (non-fatal):", error);
    }
  }

  /**
   * Auto-populate from twining_handoff.
   * Creates agent entities, handoff relation, file entities for artifacts,
   * produces relations, scope affects relation.
   */
  async onHandoff(input: {
    source_agent: string;
    target_agent?: string;
    scope?: string;
    results?: Array<{ artifacts?: string[] }>;
  }): Promise<void> {
    try {
      // Source agent entity
      const sourceEntity = await this.graphEngine.addEntity({
        name: input.source_agent,
        type: "agent",
      });

      // Target agent entity + handoff relation
      if (input.target_agent) {
        const targetEntity = await this.graphEngine.addEntity({
          name: input.target_agent,
          type: "agent",
        });
        await this.graphEngine.addRelation({
          source: sourceEntity.name,
          target: targetEntity.name,
          type: "related_to",
          properties: { type: "handoff" },
        });
      }

      // Artifact file entities with produces relations
      if (input.results) {
        for (const result of input.results) {
          for (const artifact of result.artifacts ?? []) {
            await this.graphEngine.addEntity({
              name: artifact,
              type: "file",
              properties: { produced_by: input.source_agent },
            });
            await this.graphEngine.addRelation({
              source: input.source_agent,
              target: artifact,
              type: "produces",
            });
          }
        }
      }

      // Scope entity with affects relation
      if (input.scope && input.scope !== "project") {
        let scopeType: Entity["type"] = "module";
        if (isFileLikeScope(input.scope)) {
          scopeType = "file";
        }
        const scopeEntity = await this.graphEngine.addEntity({
          name: input.scope,
          type: scopeType,
        });
        await this.graphEngine.addRelation({
          source: input.source_agent,
          target: scopeEntity.name,
          type: "affects",
          properties: { via: "handoff" },
        });
      }
    } catch (error) {
      console.error("[twining] GraphAutoPopulator.onHandoff failed (non-fatal):", error);
    }
  }

  /**
   * Auto-populate from twining_link_commit.
   * Creates commit entity with decided_by relation to decision.
   */
  async onLinkCommit(decisionId: string, commitHash: string): Promise<void> {
    try {
      await this.graphEngine.addEntity({
        name: commitHash,
        type: "commit",
        properties: { decision: decisionId },
      });
      await this.graphEngine.addRelation({
        source: commitHash,
        target: decisionId,
        type: "decided_by",
      });
    } catch (error) {
      console.error("[twining] GraphAutoPopulator.onLinkCommit failed (non-fatal):", error);
    }
  }

  /**
   * Auto-populate from twining_register.
   * Creates agent entity with capabilities and role as properties.
   */
  async onRegister(
    agentId: string,
    capabilities?: string[],
    role?: string,
  ): Promise<void> {
    try {
      const properties: Record<string, string> = {};
      if (capabilities && capabilities.length > 0) {
        properties.capabilities = capabilities.join(", ");
      }
      if (role) {
        properties.role = role;
      }
      await this.graphEngine.addEntity({
        name: agentId,
        type: "agent",
        properties,
      });
    } catch (error) {
      console.error("[twining] GraphAutoPopulator.onRegister failed (non-fatal):", error);
    }
  }

  /**
   * Auto-populate from twining_reconsider or twining_override.
   * Creates challenged relation from agent to decision.
   */
  async onChallenge(
    agentId: string,
    decisionId: string,
    action: "reconsider" | "override",
  ): Promise<void> {
    try {
      // Ensure agent entity exists
      await this.graphEngine.addEntity({
        name: agentId,
        type: "agent",
      });
      await this.graphEngine.addRelation({
        source: agentId,
        target: decisionId,
        type: "challenged",
        properties: { action },
      });
    } catch (error) {
      console.error("[twining] GraphAutoPopulator.onChallenge failed (non-fatal):", error);
    }
  }
}
