/**
 * Shared #40 resolution predicate.
 * A need/warning (extended to question by triage) counts as resolved when
 * any live entry back-references its id via relates_to. Type-agnostic,
 * order-agnostic, no self-reference exclusion — the archiver's canonical
 * behavior, preserved exactly.
 */
import type { BlackboardEntry } from "../utils/types.js";

/** Collect every entry id back-referenced by any entry's relates_to. */
export function computeResolvedIds(entries: BlackboardEntry[]): Set<string> {
  const resolvedIds = new Set<string>();
  for (const entry of entries) {
    for (const id of entry.relates_to ?? []) resolvedIds.add(id);
  }
  return resolvedIds;
}
