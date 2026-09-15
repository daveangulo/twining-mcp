/**
 * Structural checks over the oracle corpus (lane 05).
 *
 * These assert nothing about any EXPECTATION — only that the corpus is
 * machine-readable, complete in the way the programme requires, and that the
 * held-out set really is a different set of names, wordings and identities
 * rather than a copy of the development set.
 */
import { describe, expect, it } from "vitest";

import { caseIds, hasVariant, identityOverlap, inventory, readFixtures, readOracleText } from "./oracles.js";

/**
 * The five cases the lane 02 vertical slice discharged directly. They were
 * written without a held-out twin; everything added afterwards has one.
 * Recorded here so the gap is an explicit, reviewable fact rather than a
 * silent absence. Lane 05 does not invent the missing variants: authoring a
 * held-out twin for a case whose dev oracle has already been observed in
 * implementation would not be blind, and a non-blind held-out set is worthless.
 */
export const NO_HELDOUT_BY_DESIGN = ["C09", "C10", "C11", "C14", "C16"];

describe("oracle corpus", () => {
  const ids = caseIds();

  it("has 28 cases, C01..C28, with no gaps", () => {
    expect(ids).toHaveLength(28);
    expect(ids).toEqual(Array.from({ length: 28 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`));
  });

  /**
   * FINDING F-CASEID (reported, scope test/acceptance/): `case_id` is not
   * uniform. Development sets use `C02` or `C02-DEV`; held-out sets use
   * `C01-HO`, `C02-HELDOUT`, `C04-H`, … and at least one set omits `version`.
   * The gate therefore checks the CASE NUMBER, not the literal string: lane 05
   * will not rewrite 51 fixture identity fields to satisfy a cosmetic rule,
   * and `case_id` is fixture metadata rather than an expectation.
   */
  it.each(ids)("%s development fixtures parse as JSON and name their case", (id) => {
    const fx = readFixtures<Record<string, unknown>>(id);
    expect(String(fx.case_id)).toMatch(new RegExp(`^${id}(?:-[A-Z]+)?$`));
  });

  it.each(ids.filter((id) => !NO_HELDOUT_BY_DESIGN.includes(id)))("%s held-out fixtures parse as JSON and name their case", (id) => {
    expect(hasVariant(id, "heldout")).toBe(true);
    const fx = readFixtures<Record<string, unknown>>(id, "heldout");
    expect(String(fx.case_id)).toMatch(new RegExp(`^${id}(?:-[A-Z]+)?$`));
  });

  it("the held-out gap is exactly the five slice cases", () => {
    expect(ids.filter((id) => !hasVariant(id, "heldout"))).toEqual(NO_HELDOUT_BY_DESIGN);
  });

  it.each(ids)("%s declares a usable structured invariants list", (id) => {
    // A one-entry invariants list is the C18 defect lane 05 normalized on
    // 2026-09-15; the floor is deliberately low (a case may honestly have few)
    // but a single entry means the return value was truncated.
    expect(inventory(id).invariants.length, `${id} structured invariants`).toBeGreaterThan(1);
  });

  /**
   * FINDING F-CONTROLS (reported, scope test/acceptance/): the five cases the
   * lane 02 vertical slice discharged directly (C09-C11, C14, C16) have NO
   * "Instrument-can-fail controls" section. Their controls live in the slice
   * tests' own mutation checks and in appendix B instead. That is a real
   * coverage asymmetry — those five cases' negative assertions have no written
   * statement of what must break them — and it is recorded here rather than
   * papered over. Lane 05 does not author controls for them: doing so after
   * the implementation exists would not be implementation-blind.
   */
  it.each(ids.filter((id) => !NO_HELDOUT_BY_DESIGN.includes(id)))("%s declares instrument-can-fail controls", (id) => {
    expect(inventory(id).controls.length, `${id} instrument-can-fail controls`).toBeGreaterThan(0);
  });

  it("the controls gap is exactly the five slice cases", () => {
    expect(ids.filter((id) => inventory(id).controls.length === 0)).toEqual(NO_HELDOUT_BY_DESIGN);
  });

  it.each(ids)("%s names at least one assertion id the index can track", (id) => {
    const inv = inventory(id);
    expect(inv.ids.length, `${id} assertion ids (mode=${inv.mode})`).toBeGreaterThan(0);
  });

  it.each(ids.filter((id) => !NO_HELDOUT_BY_DESIGN.includes(id)))(
    "%s held-out oracle is not a copy of the development oracle",
    (id) => {
      const dev = readOracleText(id);
      const held = readOracleText(id, "heldout");
      expect(held).not.toEqual(dev);
      // Different identities, not merely different prose: a held-out set that
      // reuses the development principals/hosts/stores is not held out.
      const overlap = identityOverlap(id);
      expect(overlap, `${id} dev/held-out identity overlap ${Math.round(overlap * 100)}%`).toBeLessThan(0.2);
    },
  );
});
