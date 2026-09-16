/**
 * Lane 04 — retrieval and trust.
 *
 * Recall that is useful WITHOUT mixing repositories, revisions, attempts,
 * historical states or authority classes.
 *
 * Read `select.ts` first: it holds the one predicate every retrieval path runs
 * before any ranking, and the reasoning for why read visibility is a third
 * scope operation distinct from `scopeMatches` and `scopeGoverns`.
 */
export * from "./select.js";
export * from "./lifecycle.js";
export * from "./tokenizer.js";
export * from "./render.js";
export * from "./packet.js";
export * from "./receipts.js";
export * from "./explain.js";
export * from "./store-identity.js";
