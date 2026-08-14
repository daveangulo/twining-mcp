/**
 * Legacy duplicate-relation dedup (wave-2 follow-up). The 2.11.0 upsert
 * prevents NEW duplicate (source, target, type) edges and merges into the
 * seq-first existing one — this pass cleans up the pre-upsert duplicates
 * field stores still hold. Survivor = the seq-first edge (the same edge
 * every upsert already merges into; the created-at-oldest on the file
 * backend); later duplicates fold their properties into it in order under
 * the origin-precedence rule, then are removed. Removal is by id, so a
 * duplicate whose id is not globally unique (possible in the file backend
 * after a union-style git merge of relations.json; sqlite enforces UNIQUE)
 * is skipped and counted rather than risking deleting the survivor or an
 * unrelated edge that shares the id. A group whose property fold fails
 * (e.g. a dangling endpoint entity) is skipped and counted without
 * blocking the remaining groups. Preview by default; execute applies.
 */
import { mergeRelationProperties } from "../utils/relation-properties.js";
import type { IGraphStore } from "../storage/interfaces.js";

export interface RelationDedupReport {
  duplicate_groups: number;
  duplicate_relations: number;
  removed: number;
  /** Duplicates left in place because their id is shared with the survivor or another edge — removal by id would over-delete. */
  skipped_id_collisions: number;
  /** Execute only: groups left untouched because the property fold failed (e.g. dangling endpoint entity). */
  failed_groups: number;
  /** First few fold-failure messages (capped at 5). */
  errors: string[];
  by_type: Record<string, number>;
}

export async function dedupRelations(
  graphStore: IGraphStore,
  execute: boolean,
): Promise<RelationDedupReport> {
  const relations = await graphStore.getRelations();
  const idCount = new Map<string, number>();
  const groups = new Map<string, typeof relations>();
  for (const r of relations) {
    idCount.set(r.id, (idCount.get(r.id) ?? 0) + 1);
    const key = `${r.source}\u0000${r.target}\u0000${r.type}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const report: RelationDedupReport = {
    duplicate_groups: 0,
    duplicate_relations: 0,
    removed: 0,
    skipped_id_collisions: 0,
    failed_groups: 0,
    errors: [],
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

    // Removal is by id: an id shared with the survivor (exact-duplicate row)
    // or with any other edge would over-delete, so those stay in place and
    // are only counted. Counted in preview too — parity with execute (#39).
    let merged = survivor.properties;
    const removable: string[] = [];
    for (const dup of list.slice(1)) {
      merged = mergeRelationProperties(merged, dup.properties);
      if (dup.id !== survivor.id && idCount.get(dup.id) === 1) {
        removable.push(dup.id);
      } else {
        report.skipped_id_collisions++;
      }
    }
    if (!execute) continue;
    try {
      // addRelation upserts into the surviving (seq-first) edge, applying the
      // merged properties under the same precedence rule a live write uses.
      await graphStore.addRelation({
        source: survivor.source,
        target: survivor.target,
        type: survivor.type,
        properties: merged,
      });
    } catch (error) {
      // One bad group (dangling endpoint, ambiguous name) must not abort the
      // pass: skip its removals, keep going, and surface the failure.
      report.failed_groups++;
      if (report.errors.length < 5) {
        report.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
      continue;
    }
    for (const id of removable) doomed.add(id);
  }

  if (execute && doomed.size > 0) {
    const { removed } = await graphStore.removeRelations(doomed);
    report.removed = removed;
  }
  return report;
}
