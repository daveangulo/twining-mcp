/**
 * Delivery state machine per (event, replica) — ADR §5. `local_persisted` is
 * the producer's durable acknowledgement boundary; nothing beyond it is
 * implied by it. Terminal-ish states (`quarantined`, `rejected`) keep the
 * bytes as evidence; nothing is ever dropped.
 */
export const DELIVERY_STATES = [
  "local_persisted",
  "exported",
  "transferred",
  "received",
  "pending_parents",
  "admitted",
  "quarantined",
  "rejected",
  "projected",
  "injected",
  "task_acked",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_TRANSITIONS: Record<DeliveryState, ReadonlyArray<DeliveryState>> = {
  local_persisted: ["exported", "admitted"], // a producer admits its own event locally
  exported: ["transferred"],
  transferred: ["received"],
  received: ["admitted", "pending_parents", "quarantined", "rejected"],
  pending_parents: ["admitted", "quarantined", "rejected"],
  admitted: ["projected"],
  quarantined: ["admitted", "rejected"], // an operator or a later policy can re-admit
  rejected: [],
  projected: ["injected"],
  injected: ["task_acked", "injected"], // injected into several turns
  task_acked: [],
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

/** Reasons that keep bytes but withhold application. */
export const QUARANTINE_REASONS = [
  "unknown_kind",
  "unauthorized_cross_scope",
  "signature_required",
  "signature_invalid",
  "unauthorized_principal",
  "envelope_version_unsupported",
  "attachment_missing",
  "signer_unknown", // retryable: the principal record may still be in flight
  "no_policy_yet", // retryable: capability cannot be judged until the membership arrives
  "signer_untrusted", // retryable: the key resolves but is outside this store's chain of trust (ADR §7, C12)
] as const;
export const REJECT_REASONS = [
  "schema",
  "digest_mismatch",
  "conflicting_duplicate",
  "cycle",
  "class_not_allowed",
  "unauthorized",
  /** The signing key was revoked before this event; terminal, never retried. */
  "credential_revoked",
  /** producer.principal is not the principal the signing key is bound to (R03/R17). */
  "author_assertion_not_authenticated",
  /** A parent was rejected, so this event can never become admissible (C18 A9, C28 A13). */
  "parent_rejected",
] as const;
