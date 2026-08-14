/**
 * Shared relation-property merge for the graph upsert (wave C), consumed by
 * BOTH backends — the entity-properties precedent: byte-identical merges in
 * two stores diverge eventually, so the rule lives once.
 *
 * Last-wins per key, EXCEPT origin precedence: a machine-derived write never
 * downgrades an agent-declared edge ("derived" cannot overwrite "declared" —
 * routine populator re-upserts would silently corrupt provenance), while
 * "declared" upgrading "derived" is an agent confirming a machine guess.
 */
export function mergeRelationProperties(
  existing: Record<string, string>,
  incoming: Record<string, string> | undefined,
): Record<string, string> {
  const merged = { ...existing, ...(incoming ?? {}) };
  if (existing.origin === "declared" && incoming?.origin === "derived") {
    merged.origin = "declared";
  }
  return merged;
}
