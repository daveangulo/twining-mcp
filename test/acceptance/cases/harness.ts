/**
 * Shared fixtures for the lane-04 acceptance cases.
 *
 * Builds a real v3 `EventStore` (so lifecycle states come from the reducer, not
 * from a test double) and wraps its read paths in the lane-04 scope gate, which
 * is the thing under test.
 */
import {
  makeWorld,
  makeIdentity,
  newStore,
  created,
  buildEvent,
  policyEvents,
  deliver,
  admitAndProject,
  cleanupTempDirs,
  type World,
  type Identity,
} from "../slice/harness.js";
import type { EventStore } from "../../../src/events/event-store.js";
import type { SliceProjectedRecord } from "../../../src/events/projection.js";
import type { Scope } from "../../../src/contracts/scope.js";
import {
  selectCandidates,
  readByIdInScope,
  type SelectionRequest,
  type SelectionOutcome,
} from "../../../src/retrieval/select.js";

export {
  makeWorld,
  makeIdentity,
  newStore,
  created,
  buildEvent,
  policyEvents,
  deliver,
  admitAndProject,
  cleanupTempDirs,
};
export type { World, Identity, SliceProjectedRecord };

/**
 * The scoped read path. Every case calls this rather than `store.query()`
 * directly — the whole point of lane 04 is that no caller reaches the store
 * without the gate.
 */
export async function scopedQuery(
  store: EventStore,
  req: SelectionRequest,
  opts: { include_retired?: boolean; include_archived?: boolean; record_type?: string } = {},
): Promise<SelectionOutcome<SliceProjectedRecord>> {
  // Deliberately ask the store for EVERYTHING and let the gate cut. A test that
  // pre-filtered with the store's own scope argument could pass while the gate
  // did nothing, which is exactly the vacuity the oracles warn about.
  const all = await store.query({ ...opts });
  return selectCandidates(all, (r) => r.scope as Scope, (r) => r.record_id, req);
}

/** Exact-id read, gated. An out-of-scope id must be indistinguishable from absent. */
export async function scopedGet(
  store: EventStore,
  recordId: string,
  req: SelectionRequest,
): Promise<{ ok: true; record: SliceProjectedRecord } | { ok: false; reason: "not_found_in_scope" }> {
  const rec = await store.get(recordId);
  return readByIdInScope(rec, (r) => r.scope as Scope, req);
}

/** The scoped historical view (C25 A15, C19 A16, C05 A3). */
export async function scopedHistory(
  store: EventStore,
  req: SelectionRequest,
  opts: { include_retired?: boolean; include_archived?: boolean } = { include_retired: true, include_archived: true },
): Promise<SelectionOutcome<SliceProjectedRecord>> {
  const all = await store.query(opts);
  // The history path runs the SAME gate. `history_view_leak_on` is the control
  // that bypasses it, and must make the history assertions fail.
  if (req.disable?.history_view_leak_on) {
    return {
      admitted: all,
      suppressed: {},
      suppressed_visible: [],
      suppressed_detail: [],
      outcome: "ok",
      filters: { mode: req.mode ?? "strict", authorized_digest: "", query_scope: req.query, scope_filter_applied: false },
    };
  }
  return selectCandidates(all, (r) => r.scope as Scope, (r) => r.record_id, req);
}

/** A principal's request shape. */
export function requestFor(
  principal: string,
  authorized: Scope[],
  query: Scope,
  extra: Partial<SelectionRequest> = {},
): SelectionRequest {
  return { principal, authorized, query, mode: "strict", ...extra };
}
