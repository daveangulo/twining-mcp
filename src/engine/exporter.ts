/**
 * Exporter engine — generates a single markdown snapshot of all Twining state.
 * Reads blackboard, decisions, and knowledge graph stores.
 * Supports optional scope filtering for targeted exports.
 */
import type { BlackboardStore } from "../storage/blackboard-store.js";
import type { DecisionStore } from "../storage/decision-store.js";
import type { GraphStore } from "../storage/graph-store.js";
import type {
  BlackboardEntry,
  Decision,
  DecisionStatus,
  Entity,
  Relation,
} from "../utils/types.js";

export interface ExportStats {
  blackboard_entries: number;
  decisions: number;
  graph_entities: number;
  graph_relations: number;
  scope: string;
}

export class Exporter {
  constructor(
    private readonly blackboardStore: BlackboardStore,
    private readonly decisionStore: DecisionStore,
    private readonly graphStore: GraphStore,
  ) {}

  /**
   * Export full Twining state as a single markdown document.
   * If scope is provided, filters all data to that scope.
   */
  async exportMarkdown(
    scope?: string,
  ): Promise<{ markdown: string; stats: ExportStats }> {
    // Load all data
    const { entries: allEntries } = await this.blackboardStore.read();
    const allIndex = await this.decisionStore.getIndex();
    const allEntities = await this.graphStore.getEntities();
    const allRelations = await this.graphStore.getRelations();

    // Apply scope filtering
    let entries: BlackboardEntry[];
    let decisions: Decision[];
    let entities: Entity[];
    let relations: Relation[];

    if (scope) {
      // Blackboard: bidirectional prefix match
      entries = allEntries.filter(
        (e) => e.scope.startsWith(scope) || scope.startsWith(e.scope),
      );

      // Decisions: filter index by scope prefix match or affected_files prefix match
      const matchingIndex = allIndex.filter(
        (e) =>
          e.scope.startsWith(scope) ||
          scope.startsWith(e.scope) ||
          e.affected_files.some(
            (f) => f.startsWith(scope) || scope.startsWith(f),
          ),
      );
      decisions = [];
      for (const entry of matchingIndex) {
        const decision = await this.decisionStore.get(entry.id);
        if (decision) decisions.push(decision);
      }

      // Graph: entities where name or any property value contains the scope substring
      entities = allEntities.filter(
        (e) =>
          e.name.includes(scope) ||
          Object.values(e.properties).some((v) => v.includes(scope)),
      );
      const includedEntityIds = new Set(entities.map((e) => e.id));
      // Relations where either source or target entity is included
      relations = allRelations.filter(
        (r) =>
          includedEntityIds.has(r.source) || includedEntityIds.has(r.target),
      );
    } else {
      entries = allEntries;
      // Load all full decisions
      decisions = [];
      for (const entry of allIndex) {
        const decision = await this.decisionStore.get(entry.id);
        if (decision) decisions.push(decision);
      }
      entities = allEntities;
      relations = allRelations;
    }

    // Sort decisions by timestamp descending
    decisions.sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) ||
        b.id.localeCompare(a.id),
    );

    // Sort blackboard by timestamp descending
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Sort entities alphabetically by name
    entities.sort((a, b) => a.name.localeCompare(b.name));

    // Build entity ID -> name map for relation resolution
    const entityNameMap = new Map<string, string>();
    for (const e of allEntities) {
      entityNameMap.set(e.id, e.name);
    }

    // Count decision statuses
    const statusCounts: Record<DecisionStatus, number> = {
      active: 0,
      provisional: 0,
      superseded: 0,
      overridden: 0,
    };
    for (const d of decisions) {
      statusCounts[d.status]++;
    }

    // Build stats
    const stats: ExportStats = {
      blackboard_entries: entries.length,
      decisions: decisions.length,
      graph_entities: entities.length,
      graph_relations: relations.length,
      scope: scope ?? "all",
    };

    // Build markdown
    const lines: string[] = [];

    lines.push("# Twining State Export");
    lines.push("");
    lines.push(`*Exported: ${new Date().toISOString()}*`);
    if (scope) {
      lines.push(`*Scope: ${scope}*`);
    }
    lines.push("");

    // Summary section
    lines.push("## Summary");
    lines.push("");
    lines.push(`- Blackboard entries: ${entries.length}`);
    lines.push(
      `- Decisions: ${decisions.length} (${statusCounts.active} active, ${statusCounts.provisional} provisional, ${statusCounts.superseded} superseded, ${statusCounts.overridden} overridden)`,
    );
    lines.push(`- Graph entities: ${entities.length}`);
    lines.push(`- Graph relations: ${relations.length}`);
    lines.push("");

    // Decisions section
    lines.push("## Decisions");
    lines.push("");
    if (decisions.length === 0) {
      lines.push("*No decisions recorded.*");
      lines.push("");
    } else {
      for (const d of decisions) {
        lines.push(`### ${d.summary}`);
        lines.push("");
        lines.push("| Field | Value |");
        lines.push("|-------|-------|");
        lines.push(`| ID | ${d.id} |`);
        lines.push(`| Domain | ${d.domain} |`);
        lines.push(`| Scope | ${d.scope} |`);
        lines.push(`| Status | ${d.status} |`);
        lines.push(`| Confidence | ${d.confidence} |`);
        lines.push(`| Timestamp | ${d.timestamp} |`);
        lines.push(
          `| Commits | ${d.commit_hashes && d.commit_hashes.length > 0 ? d.commit_hashes.join(", ") : "none"} |`,
        );
        lines.push("");
        lines.push(`**Context:** ${d.context}`);
        lines.push("");
        lines.push(`**Rationale:** ${d.rationale}`);
        lines.push("");
        if (d.alternatives && d.alternatives.length > 0) {
          lines.push("**Alternatives considered:**");
          for (const alt of d.alternatives) {
            lines.push(`- ${alt.option}: ${alt.reason_rejected}`);
          }
          lines.push("");
        }
        lines.push("---");
        lines.push("");
      }
    }

    // Blackboard section
    lines.push("## Blackboard");
    lines.push("");
    if (entries.length === 0) {
      lines.push("*No blackboard entries.*");
      lines.push("");
    } else {
      lines.push("| Timestamp | Type | Summary | Scope |");
      lines.push("|-----------|------|---------|-------|");
      for (const e of entries) {
        lines.push(`| ${e.timestamp} | ${e.entry_type} | ${e.summary} | ${e.scope} |`);
      }
      lines.push("");
    }

    // Knowledge Graph section
    lines.push("## Knowledge Graph");
    lines.push("");

    lines.push("### Entities");
    lines.push("");
    if (entities.length === 0) {
      lines.push("*No entities.*");
      lines.push("");
    } else {
      lines.push("| Name | Type | Properties |");
      lines.push("|------|------|------------|");
      for (const e of entities) {
        lines.push(
          `| ${e.name} | ${e.type} | ${JSON.stringify(e.properties)} |`,
        );
      }
      lines.push("");
    }

    lines.push("### Relations");
    lines.push("");
    if (relations.length === 0) {
      lines.push("*No relations.*");
      lines.push("");
    } else {
      lines.push("| Source | Relation | Target |");
      lines.push("|--------|----------|--------|");
      for (const r of relations) {
        const sourceName = entityNameMap.get(r.source) ?? r.source;
        const targetName = entityNameMap.get(r.target) ?? r.target;
        lines.push(`| ${sourceName} | ${r.type} | ${targetName} |`);
      }
      lines.push("");
    }

    const markdown = lines.join("\n");
    return { markdown, stats };
  }
}
