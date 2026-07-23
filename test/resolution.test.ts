import { describe, it, expect } from "vitest";
import { computeResolvedIds } from "../src/engine/resolution.js";
import type { BlackboardEntry, EntryType } from "../src/utils/types.js";

/** Minimal blackboard entry fixture. */
function makeEntry(
  id: string,
  entry_type: EntryType,
  extra: Partial<BlackboardEntry> = {},
): BlackboardEntry {
  return {
    id,
    timestamp: "2026-07-01T00:00:00.000Z",
    agent_id: "test",
    entry_type,
    tags: [],
    scope: "project",
    summary: `entry ${id}`,
    detail: "",
    ...extra,
  };
}

describe("computeResolvedIds", () => {
  it("collects ids back-referenced via relates_to", () => {
    const need = makeEntry("need-1", "need");
    const resolver = makeEntry("status-1", "status", {
      relates_to: ["need-1"],
    });
    const resolved = computeResolvedIds([need, resolver]);
    expect(resolved.has("need-1")).toBe(true);
    expect(resolved.has("status-1")).toBe(false);
  });

  it("returns an empty set when no entry has relates_to", () => {
    const entries = [makeEntry("a", "need"), makeEntry("b", "warning")];
    expect(computeResolvedIds(entries).size).toBe(0);
  });

  it("is type-agnostic — a resolver of any entry_type counts", () => {
    const warning = makeEntry("warn-1", "warning");
    const finding = makeEntry("find-1", "finding", {
      relates_to: ["warn-1"],
    });
    expect(computeResolvedIds([warning, finding]).has("warn-1")).toBe(true);
  });

  it("a self-referencing entry resolves itself", () => {
    const need = makeEntry("need-self", "need", {
      relates_to: ["need-self"],
    });
    expect(computeResolvedIds([need]).has("need-self")).toBe(true);
  });

  it("is order-agnostic — an earlier-timestamped resolver resolves", () => {
    const need = makeEntry("need-late", "need", {
      timestamp: "2026-07-02T00:00:00.000Z",
    });
    const earlierResolver = makeEntry("status-early", "status", {
      timestamp: "2026-07-01T00:00:00.000Z",
      relates_to: ["need-late"],
    });
    // Resolver both before and after the target in array order
    expect(computeResolvedIds([earlierResolver, need]).has("need-late")).toBe(
      true,
    );
    expect(computeResolvedIds([need, earlierResolver]).has("need-late")).toBe(
      true,
    );
  });

  it("collects every id from a multi-id relates_to", () => {
    const resolver = makeEntry("status-multi", "status", {
      relates_to: ["a", "b", "c"],
    });
    const resolved = computeResolvedIds([resolver]);
    expect(resolved).toEqual(new Set(["a", "b", "c"]));
  });
});
