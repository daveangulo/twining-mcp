/**
 * Analytics engine — computes value stats from existing .twining/ data.
 * No new data collection needed — reads existing stores.
 */
import type { BlackboardStore } from "../storage/blackboard-store.js";
import type { DecisionStore } from "../storage/decision-store.js";
import type { GraphStore } from "../storage/graph-store.js";
import type { HandoffStore } from "../storage/handoff-store.js";
import type { ValueStats } from "../utils/types.js";

export class AnalyticsEngine {
  constructor(
    private readonly blackboardStore: BlackboardStore,
    private readonly decisionStore: DecisionStore,
    private readonly graphStore: GraphStore,
    private readonly handoffStore: HandoffStore,
  ) {}

  async computeValueStats(): Promise<ValueStats> {
    const [
      decisionIndex,
      bbResult,
      entities,
      relations,
      handoffs,
    ] = await Promise.all([
      this.decisionStore.getIndex(),
      this.blackboardStore.read(),
      this.graphStore.getEntities(),
      this.graphStore.getRelations(),
      this.handoffStore.list({}),
    ]);

    // Blind decisions prevented
    const totalDecisions = decisionIndex.length;
    let assembledBefore = 0;
    for (const dec of decisionIndex) {
      const full = await this.decisionStore.get(dec.id);
      if (full?.assembled_before) {
        assembledBefore++;
      }
    }
    const preventionRate = totalDecisions > 0 ? assembledBefore / totalDecisions : 0;

    // Warnings surfaced
    const warnings = bbResult.entries.filter((e) => e.entry_type === "warning");
    const warningTotal = warnings.length;
    // Check for acknowledgment patterns: relates_to links or answer entries
    const answerRelatesTo = new Set(
      bbResult.entries
        .filter((e) => e.entry_type === "answer")
        .flatMap((e) => e.relates_to || []),
    );
    const acknowledged = warnings.filter(
      (w) => answerRelatesTo.has(w.id) || w.tags.includes("acknowledged"),
    ).length;
    const resolved = warnings.filter((w) => w.tags.includes("resolved")).length;
    const ignored = warningTotal - acknowledged - resolved;

    // Test coverage via graph relations
    const testedByRelations = relations.filter((r) => r.type === "tested_by");
    const decisionsWithTests = new Set(
      testedByRelations.map((r) => r.source),
    );
    const withTestedBy = decisionIndex.filter(
      (d) => decisionsWithTests.has(d.id),
    ).length;
    const coverageRate = totalDecisions > 0 ? withTestedBy / totalDecisions : 0;

    // Decision lifecycle
    const lifecycle = { active: 0, provisional: 0, superseded: 0, overridden: 0 };
    for (const dec of decisionIndex) {
      if (dec.status in lifecycle) {
        lifecycle[dec.status as keyof typeof lifecycle]++;
      }
    }

    // Commit traceability
    const withCommits = decisionIndex.filter(
      (d) => d.commit_hashes && d.commit_hashes.length > 0,
    ).length;
    const traceabilityRate = totalDecisions > 0 ? withCommits / totalDecisions : 0;

    // Knowledge graph
    const entitiesByType: Record<string, number> = {};
    for (const entity of entities) {
      entitiesByType[entity.type] = (entitiesByType[entity.type] || 0) + 1;
    }
    const relationsByType: Record<string, number> = {};
    for (const relation of relations) {
      relationsByType[relation.type] = (relationsByType[relation.type] || 0) + 1;
    }

    // Agent coordination (handoffs are HandoffIndexEntry with result_status + acknowledged)
    const byResultStatus: Record<string, number> = {};
    let acknowledgedHandoffs = 0;
    for (const handoff of handoffs) {
      const status = handoff.result_status || "unknown";
      byResultStatus[status] = (byResultStatus[status] || 0) + 1;
      if (handoff.acknowledged) {
        acknowledgedHandoffs++;
      }
    }
    const acknowledgmentRate = handoffs.length > 0
      ? acknowledgedHandoffs / handoffs.length
      : 0;

    return {
      blind_decisions_prevented: {
        total_decisions: totalDecisions,
        assembled_before: assembledBefore,
        prevention_rate: Math.round(preventionRate * 100) / 100,
      },
      warnings_surfaced: {
        total: warningTotal,
        acknowledged,
        resolved,
        ignored: Math.max(0, ignored),
      },
      test_coverage: {
        total_decisions: totalDecisions,
        with_tested_by: withTestedBy,
        coverage_rate: Math.round(coverageRate * 100) / 100,
      },
      decision_lifecycle: lifecycle,
      commit_traceability: {
        total_decisions: totalDecisions,
        with_commits: withCommits,
        traceability_rate: Math.round(traceabilityRate * 100) / 100,
      },
      knowledge_graph: {
        entities: entities.length,
        relations: relations.length,
        entities_by_type: entitiesByType,
        relations_by_type: relationsByType,
      },
      agent_coordination: {
        total_handoffs: handoffs.length,
        by_result_status: byResultStatus,
        acknowledgment_rate: Math.round(acknowledgmentRate * 100) / 100,
      },
    };
  }
}
