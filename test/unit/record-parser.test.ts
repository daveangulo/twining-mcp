import { describe, it, expect } from "vitest";
import { parseDecision } from "../../src/engine/record-parser.js";

describe("parseDecision — existing behavior (regression)", () => {
  it("splits summary and rationale on em-dash", () => {
    const parsed = parseDecision(
      "Chose Redis over Memcached — need persistence across restarts",
    );
    expect(parsed.summary).toBe("Chose Redis over Memcached");
    expect(parsed.rationale).toBe("need persistence across restarts");
  });

  it("detects 'over X' rejected alternative", () => {
    const parsed = parseDecision(
      "Chose Redis over Memcached — need persistence across restarts",
    );
    expect(parsed.rejected_alternatives.map((a) => a.option)).toContain("Memcached");
  });

  it("detects 'instead of X' rejected alternative", () => {
    const parsed = parseDecision(
      "Used event-driven pattern instead of callbacks because cleaner",
    );
    expect(parsed.rejected_alternatives.map((a) => a.option)).toContain("callbacks");
  });

  it("falls back to summary as rationale when no separator", () => {
    const parsed = parseDecision("Reverted the workaround");
    expect(parsed.summary).toBe("Reverted the workaround");
    expect(parsed.rationale).toBe("Reverted the workaround");
  });
});

describe("parseDecision — multi-separator preservation (bug fix)", () => {
  it("does not drop content after the second rationale separator", () => {
    // Prior behavior: split(regex, 2) silently dropped everything after
    // the second match. With the fix, the full rationale is preserved.
    const text =
      "Chose event-driven over callbacks — cleaner composition, and it scales as load grows";
    const parsed = parseDecision(text);
    // Summary is before the first separator (em-dash).
    expect(parsed.summary).toBe("Chose event-driven over callbacks");
    // Rationale must contain the tail beyond the second " as " separator.
    expect(parsed.rationale).toContain("scales");
    expect(parsed.rationale).toContain("load grows");
  });

  it("preserves a long multi-sentence rationale when a mid-sentence word would otherwise split it", () => {
    const text =
      "Benchmark scope is the macro loop — evaluation across multiple sprints and releases on a sustained codebase. The unit of evaluation is the codebase over time, not single sessions. Agent Teams is reframed as a tool inside the inner loop (orthogonal to substrate choice).";
    const parsed = parseDecision(text);
    expect(parsed.summary).toBe("Benchmark scope is the macro loop");
    // Content past the second separator (" as ") must survive.
    expect(parsed.rationale).toContain("a tool inside the inner loop");
    expect(parsed.rationale).toContain("substrate choice");
  });
});

describe("parseDecision — explicit Rationale/Why/Reason markers (bug fix)", () => {
  it("prefers an explicit 'Rationale:' marker over mid-sentence heuristic separators", () => {
    const text =
      "Picked A as the default. Rationale: it is simpler and easier to support.";
    const parsed = parseDecision(text);
    // Prior behavior: " as " would fire first, cutting summary to "Picked A".
    // With the fix, we prefer the explicit marker.
    expect(parsed.summary).toBe("Picked A as the default.");
    expect(parsed.rationale).toBe("it is simpler and easier to support.");
  });

  it("prefers 'Why:' marker", () => {
    const text = "Chose X. Why: Y is faster.";
    const parsed = parseDecision(text);
    expect(parsed.summary).toBe("Chose X.");
    expect(parsed.rationale).toBe("Y is faster.");
  });

  it("prefers 'Reason:' marker", () => {
    const text = "Did the thing. Reason: it was necessary.";
    const parsed = parseDecision(text);
    expect(parsed.summary).toBe("Did the thing.");
    expect(parsed.rationale).toBe("it was necessary.");
  });
});

describe("parseDecision — numbered-list and labelled alternatives (bug fix)", () => {
  it("detects all items in a 'Rejected alternatives: (1) ... (2) ... (3) ...' list", () => {
    const text =
      "Macro-loop framing. Rationale: no existing benchmark covers it. " +
      "Rejected alternatives: (1) Exploration-efficiency ROI as primary wedge, " +
      "(2) Shared-markdown-hurts-in-conflict as headline, " +
      "(3) Minimal coordination budget / lite-matches-full as headline, " +
      "(4) Agent Teams as primary condition.";
    const parsed = parseDecision(text);
    const options = parsed.rejected_alternatives.map((a) => a.option);
    expect(options.length).toBe(4);
    expect(options[0]).toContain("Exploration-efficiency ROI");
    expect(options[1]).toContain("Shared-markdown-hurts-in-conflict");
    expect(options[2]).toContain("Minimal coordination budget");
    expect(options[3]).toContain("Agent Teams as primary condition");
  });

  it("detects all items with 'Alternative rejected:' prefix phrasings", () => {
    const text =
      "Use X. Because Y. " +
      "Alternative rejected: option A — too slow. " +
      "Alternative rejected: option B — breaks contract. " +
      "Alternative rejected: option C — unsupported. " +
      "Alternative rejected: option D — expensive.";
    const parsed = parseDecision(text);
    expect(parsed.rejected_alternatives.length).toBe(4);
    // The labelled form is the one construction in prose that states a real
    // why-not, so it is the only one allowed to populate reason_rejected.
    expect(parsed.rejected_alternatives[0]).toEqual({
      option: "option A",
      reason_rejected: "too slow",
    });
    expect(parsed.rejected_alternatives[3]).toEqual({
      option: "option D",
      reason_rejected: "expensive",
    });
  });

  it("does not duplicate alternatives when multiple patterns would match the same item", () => {
    // "Chose X over Y" — only one alternative, not repeated across 'over' + 'instead of'.
    const parsed = parseDecision("Chose X over Y because Z");
    expect(parsed.rejected_alternatives.length).toBe(1);
    // Unordered patterns name the option but never invent a reason.
    expect(parsed.rejected_alternatives[0]).toEqual({ option: "Y" });
  });
});

describe("parseDecision — never fabricates a reason (deep review, 2026-07)", () => {
  it("omits reason_rejected when the prose did not state one", () => {
    const parsed = parseDecision("Chose Redis over Memcached — need persistence");
    for (const alt of parsed.rejected_alternatives) {
      expect(alt).not.toHaveProperty("reason_rejected");
    }
  });

  it("never emits the old 'Not chosen' placeholder", () => {
    for (const text of [
      "Chose Redis over Memcached",
      "Used events instead of callbacks",
      "Picked A rather than B",
      "Rejected alternatives: (1) X, (2) Y.",
    ]) {
      const parsed = parseDecision(text);
      for (const alt of parsed.rejected_alternatives) {
        expect(alt.reason_rejected).not.toBe("Not chosen");
      }
    }
  });
});

describe("parseDecision — patterns removed as unsalvageable", () => {
  it("does not mint an alternative from an ordinary negation", () => {
    // The bare /\bnot\b/ pattern turned prose like this into an alternative
    // named "scale". Measured at 87% noise on the real corpus.
    const parsed = parseDecision("Chose the queue — this does not scale otherwise");
    expect(parsed.rejected_alternatives.map((a) => a.option)).not.toContain("scale");
  });

  it("accepts the known cost: a genuine appositive contrast is missed", () => {
    // "X, not Y" is real contrast, but the narrower pattern that catches it
    // scored worse on real data than deletion. Pinned so it is not "fixed" back
    // without re-measuring.
    const parsed = parseDecision("Set the TTL to 30 seconds, not 5 minutes");
    expect(parsed.rejected_alternatives).toHaveLength(0);
  });

  it("does not split a summary on ' as '", () => {
    // " as " cut "Adopted the bundled server as the default" into a summary of
    // "Adopted the bundled server" with rationale "the default".
    const parsed = parseDecision("Adopted the bundled server as the default");
    expect(parsed.summary).toBe("Adopted the bundled server as the default");
    expect(parsed.rationale_source).toBe("derived");
  });
});

describe("parseDecision — negated choice does not invert the contrast", () => {
  it("does not file the KEPT option as rejected", () => {
    // Real record from this project. "over npx" names what was KEPT; the old
    // parser stored "npx" as the rejected option — a semantic inversion.
    const parsed = parseDecision(
      "Chose NOT to reorder the ladder to prefer the bundled server over npx",
    );
    expect(parsed.rejected_alternatives.map((a) => a.option)).not.toContain("npx");
  });

  it("still extracts explicitly labelled rejections inside a negated choice", () => {
    const parsed = parseDecision(
      "Chose not to rewrite the parser. Alternative rejected: full rewrite — too risky.",
    );
    expect(parsed.rejected_alternatives[0]).toEqual({
      option: "full rewrite",
      reason_rejected: "too risky",
    });
  });
});

describe("parseDecision — rationale provenance", () => {
  it("marks a separator-split rationale as authored", () => {
    expect(parseDecision("Chose X — because Y is faster").rationale_source).toBe(
      "authored",
    );
    expect(parseDecision("Chose X. Rationale: Y is faster").rationale_source).toBe(
      "authored",
    );
  });

  it("marks an echoed summary as derived, and still stores it", () => {
    const parsed = parseDecision("Reverted the workaround");
    expect(parsed.rationale_source).toBe("derived");
    // Non-empty is required downstream (decide() validation, embedding text) —
    // the marker is what tells consumers not to read it as reasoning.
    expect(parsed.rationale).toBe("Reverted the workaround");
  });
});
