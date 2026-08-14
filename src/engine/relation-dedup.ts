/**
 * Legacy duplicate-relation dedup (wave-2 follow-up). The 2.11.0 upsert
 * prevents NEW duplicate (source, target, type) edges and merges into the
 * oldest existing one — this pass cleans up the pre-upsert duplicates field
 * stores still hold. Survivor = the oldest (first in insertion order, the
 * same edge every upsert already merges into); later duplicates fold their
 * properties into it in order under the origin-precedence rule, then are
 * removed. Preview by default; execute applies.
 */
import { mergeRelationProperties } from "../utils/relation-properties.js";
import type { IGraphStore } from "../storage/interfaces.js";

export interface RelationDedupReport {
  duplicate_groups: number;
  duplicate_relations: number;
  removed: number;
  by_type: Record<string, number>;
}

export async function dedupRelations(
  graphStore: IGraphStore,
  execute: boolean,
): Promise<RelationDedupReport> {
  const relations = await graphStore.getRelations();
  const groups = new Map<string, typeof relations>();
  for (const r of relations) {
    const key = `${r.source}\u0000${r.target}\u0000${r.type}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const report: RelationDedupReport = {
    duplicate_groups: 0,
    duplicate_relations: 0,
    removed: 0,
    by_type: {},
  };
  const doomed = new Set<string>();

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    report.duplicate_groups++;
    report.duplicate_relations += list.length - 1;
    const survivor = list[0]!;
    report.by_type[survivor.type] =
      (report.by_type[survivor.type] ?? 0) + list.length - 1;
    if (execute) {
      let merged = survivor.properties;
      for (const dup of list.slice(1)) {
        merged = mergeRelationProperties(merged, dup.properties);
        doomed.add(dup.id);
      }
      // addRelation upserts into the surviving (oldest) edge, applying the
      // merged properties under the same precedence rule a live write uses.
      await graphStore.addRelation({
        source: survivor.source,
        target: survivor.target,
        type: survivor.type,
        properties: merged,
      });
    }
  }

  if (execute && doomed.size > 0) {
    const { removed } = await graphStore.removeRelations(doomed);
    report.removed = removed;
  }
  return report;
}
