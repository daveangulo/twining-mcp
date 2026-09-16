/**
 * Contract version constants (ADR docs/adr/2026-09-foundation-contracts.md).
 *
 * ENVELOPE_V is the on-disk event envelope major; CONTRACT_VERSION is the
 * semantic version of the schemas in this directory. A client refuses to WRITE
 * to a store whose format is newer than ENVELOPE_V and admits older envelopes
 * through a versioned upgrader (none exist yet — v3 is the first).
 */
export const ENVELOPE_V = 3 as const;
export const CONTRACT_VERSION = "3.0.0-draft.3";
export const STORE_FORMAT_VERSION = 3 as const;
