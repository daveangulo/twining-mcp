/**
 * Shared #40 resolution predicate.
 * A need/warning (extended to question by triage) counts as resolved when
 * any live entry back-references its id via relates_to, OR when the entry
 * itself carries persisted status "resolved" (D2). The union keeps every
 * old store's back-reference-resolved items resolved while making explicit
 * resolution survive its resolver being archived or dismissed. Type-
 * agnostic, order-agnostic, no self-reference exclusion — the archiver's
 * canonical behavior, preserved exactly.
 */
import type { BlackboardEntry } from "../utils/types.js";

/**
 * Collect every resolved entry id: explicit status "resolved" plus every
 * id back-referenced by any entry's relates_to.
 */
export function computeResolvedIds(entries: BlackboardEntry[]): Set<string> {
  const resolvedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.status === "resolved") resolvedIds.add(entry.id);
    for (const id of entry.relates_to ?? []) resolvedIds.add(id);
  }
  return resolvedIds;
}
