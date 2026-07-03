// src/migrate/verify.ts
/**
 * Read-model containment check for migrations: every record the SOURCE
 * stores can read must exist byte-identically (stable serialization) in the
 * TARGET stores. Subset — not equality — on purpose: a straggler re-run
 * migrates late legacy writes into a sqlite store that already has newer
 * records of its own, and that must verify clean.
 *
 * Works over the storage interfaces only, so either backend can be either
 * side (forward: files→sqlite, reverse: sqlite→files).
 */
import { stableStringify } from "../storage/sync/record-export.js";
import type {
  IBlackboardStore,
  IDecisionStore,
  IGraphStore,
  IHandoffStore,
} from "../storage/interfaces.js";

export interface ReadModelStores {
  blackboardStore: IBlackboardStore;
  decisionStore: IDecisionStore;
  graphStore: IGraphStore;
  handoffStore: IHandoffStore;
}

export interface VerifyResult {
  ok: boolean;
  counts: {
    posts: number;
    decisions: number;
    entities: number;
    relations: number;
    handoffs: number;
  };
  /** kind-qualified ids present in source, absent in target */
  missing: string[];
  /** kind-qualified ids present in both but not identical */
  mismatched: string[];
}

export async function verifyContains(
  source: ReadModelStores,
  target: ReadModelStores,
): Promise<VerifyResult> {
  const missing: string[] = [];
  const mismatched: string[] = [];

  const compare = (
    kind: string,
    id: string,
    src: unknown,
    tgt: unknown,
  ): void => {
    if (tgt === null || tgt === undefined) missing.push(`${kind}/${id}`);
    else if (stableStringify(src) !== stableStringify(tgt)) {
      mismatched.push(`${kind}/${id}`);
    }
  };

  const sourcePosts = (await source.blackboardStore.read()).entries;
  const targetPosts = new Map(
    (await target.blackboardStore.read()).entries.map((e) => [e.id, e]),
  );
  for (const e of sourcePosts) compare("posts", e.id, e, targetPosts.get(e.id));

  const sourceDecisionIds = (await source.decisionStore.getIndex()).map((d) => d.id);
  for (const id of sourceDecisionIds) {
    compare(
      "decisions",
      id,
      await source.decisionStore.get(id),
      await target.decisionStore.get(id),
    );
  }

  const sourceEntities = await source.graphStore.getEntities();
  const targetEntities = new Map(
    (await target.graphStore.getEntities()).map((e) => [e.id, e]),
  );
  for (const e of sourceEntities) {
    compare("entities", e.id, e, targetEntities.get(e.id));
  }

  const sourceRelations = await source.graphStore.getRelations();
  const targetRelations = new Map(
    (await target.graphStore.getRelations()).map((r) => [r.id, r]),
  );
  for (const r of sourceRelations) {
    compare("relations", r.id, r, targetRelations.get(r.id));
  }

  const sourceHandoffs = await source.handoffStore.list({});
  for (const h of sourceHandoffs) {
    compare(
      "handoffs",
      h.id,
      await source.handoffStore.get(h.id),
      await target.handoffStore.get(h.id),
    );
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    counts: {
      posts: sourcePosts.length,
      decisions: sourceDecisionIds.length,
      entities: sourceEntities.length,
      relations: sourceRelations.length,
      handoffs: sourceHandoffs.length,
    },
    missing,
    mismatched,
  };
}
