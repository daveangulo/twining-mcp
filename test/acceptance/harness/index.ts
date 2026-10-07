/**
 * Shared acceptance harness (lane 05). Everything a case test needs to drive
 * the v3 store without reimplementing identity, delivery or fault injection.
 *
 * Ownership note: this directory is lane 05's. It never edits `src/**` and
 * never edits an oracle expectation.
 */
export * from "./oracles.js";
export * from "./identity.js";
export * from "./scenario.js";
export * from "./switchboard.js";
