import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS ESM frontend module, no type declarations
import { formatAge, truncationLabel, deepLinkTab, deepLinkHash, itemBadges, groupRows, stableKey, partitionNeedsHuman, NEEDS_HUMAN_TAG } from "../../src/dashboard/public/js/triage-view.js";
// @ts-expect-error — plain-JS ESM frontend module, no type declarations
import { splitUrls, splitRepoPaths, splitLinkable, remoteBlobUrl } from "../../src/dashboard/public/js/linkify.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface Item {
  kind: string;
  id: string;
  scope: string;
  summary: string;
  agent_id: string;
  timestamp: string;
  age_ms: number;
  reversible?: boolean;
  confidence?: string;
  status?: string;
  urgency?: string;
}

function item(kind: string, id: string, extra: Partial<Item> = {}): Item {
  return {
    kind,
    id,
    scope: "src/",
    summary: `${kind} ${id}`,
    agent_id: "main",
    timestamp: "2026-07-01T00:00:00.000Z",
    age_ms: 60_000,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* formatAge                                                           */
/* ------------------------------------------------------------------ */

describe("formatAge", () => {
  it("formats minutes, hours, and days at their boundaries", () => {
    expect(formatAge(0)).toBe("now");
    expect(formatAge(59_999)).toBe("now");
    expect(formatAge(60_000)).toBe("1m");
    expect(formatAge(59 * 60_000)).toBe("59m");
    expect(formatAge(60 * 60_000)).toBe("1h");
    expect(formatAge(23 * 3_600_000)).toBe("23h");
    expect(formatAge(24 * 3_600_000)).toBe("1d");
    expect(formatAge(90 * 24 * 3_600_000)).toBe("90d");
  });

  it("returns -- for invalid input", () => {
    expect(formatAge(-1)).toBe("--");
    expect(formatAge(NaN)).toBe("--");
    expect(formatAge(undefined)).toBe("--");
  });
});

/* ------------------------------------------------------------------ */
/* truncationLabel — NORMATIVE indicator (spec §8)                     */
/* ------------------------------------------------------------------ */

describe("truncationLabel", () => {
  it("renders 'showing N of total' whenever total exceeds the array length", () => {
    expect(truncationLabel({ total: 30, irreversible: 2 }, 25)).toBe("showing 25 of 30");
    expect(truncationLabel({ total: 201, irreversible: 0 }, 200)).toBe("showing 200 of 201");
  });

  it("returns null when the array is complete", () => {
    expect(truncationLabel({ total: 5, irreversible: 0 }, 5)).toBeNull();
    expect(truncationLabel({ total: 0, irreversible: 0 }, 0)).toBeNull();
    expect(truncationLabel(undefined, 0)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* deepLinkHash — sel= mechanism reuse (spec §8)                       */
/* ------------------------------------------------------------------ */

describe("deepLinkHash", () => {
  it("routes decisions to #/decisions?sel= and blackboard kinds to #/blackboard?sel=", () => {
    expect(deepLinkHash(item("decision", "dec-1"))).toBe("#/decisions?sel=dec-1");
    for (const kind of ["need", "question", "warning", "artifact"]) {
      expect(deepLinkHash(item(kind, `bb-${kind}`))).toBe(`#/blackboard?sel=bb-${kind}`);
    }
  });

  it("URI-encodes the id", () => {
    expect(deepLinkHash(item("decision", "a b&c"))).toBe("#/decisions?sel=a%20b%26c");
  });

  it("deepLinkTab derives the tab from kind alone — the production routing rule", () => {
    expect(deepLinkTab("decision")).toBe("decisions");
    for (const kind of ["need", "question", "warning", "artifact"]) {
      expect(deepLinkTab(kind)).toBe("blackboard");
    }
  });
});

/* ------------------------------------------------------------------ */
/* stableKey — DOM-stability gate for /api/triage responses            */
/* ------------------------------------------------------------------ */

describe("stableKey", () => {
  const body = (generatedAt: string, ageMs: number) =>
    JSON.stringify({
      generated_at: generatedAt,
      window_ms: 604_800_000,
      section: "all",
      open: [item("need", "n1", { age_ms: ageMs })],
      recent: [item("decision", "d1", { age_ms: ageMs, status: "active" })],
      counts: { open: { total: 1 }, recent: { total: 1 } },
    });

  it("equates responses that differ only in generated_at and age_ms", () => {
    expect(stableKey(body("2026-07-23T00:00:00.000Z", 1000))).toBe(
      stableKey(body("2026-07-23T00:00:05.000Z", 6000)),
    );
  });

  it("distinguishes responses whose store-derived content differs", () => {
    const a = stableKey(body("2026-07-23T00:00:00.000Z", 1000));
    const changed = JSON.parse(body("2026-07-23T00:00:00.000Z", 1000));
    changed.open.push(item("warning", "w1"));
    changed.counts.open.total = 2;
    expect(stableKey(JSON.stringify(changed))).not.toBe(a);
  });

  it("falls back to the raw text for unparseable input", () => {
    expect(stableKey("not json")).toBe("not json");
  });
});

/* ------------------------------------------------------------------ */
/* itemBadges                                                          */
/* ------------------------------------------------------------------ */

describe("itemBadges", () => {
  it("gives decisions status, confidence, and irreversible badges", () => {
    const badges = itemBadges(item("decision", "d1", { status: "provisional", confidence: "high", reversible: false }));
    expect(badges).toEqual([
      { label: "provisional", cls: "provisional" },
      { label: "high", cls: "high" },
      { label: "irreversible", cls: "urgency-high" },
    ]);
  });

  it("omits the irreversible badge for reversible decisions", () => {
    const badges = itemBadges(item("decision", "d2", { status: "active", confidence: "medium", reversible: true }));
    expect(badges.map((b: { label: string }) => b.label)).toEqual(["active", "medium"]);
  });

  it("gives delegation needs an urgency badge and plain needs none", () => {
    expect(itemBadges(item("need", "n1", { urgency: "high" }))).toEqual([
      { label: "high urgency", cls: "urgency-high" },
    ]);
    expect(itemBadges(item("need", "n2"))).toEqual([]);
    expect(itemBadges(item("warning", "w1"))).toEqual([]);
    expect(itemBadges(item("artifact", "a1"))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* groupRows — client-side visual grouping (spec §8 SHOULD)            */
/* ------------------------------------------------------------------ */

describe("groupRows", () => {
  it("orders irreversible decisions, then provisional decisions, then the rest", () => {
    const rows = [
      item("need", "n1"),
      item("decision", "d-prov", { status: "provisional", reversible: true }),
      item("warning", "w1"),
      item("decision", "d-irrev", { status: "provisional", reversible: false }),
    ];
    expect(groupRows(rows).map((r: Item) => r.id)).toEqual(["d-irrev", "d-prov", "n1", "w1"]);
  });

  it("is stable within each group (preserves the API's §4.2 ordering)", () => {
    const rows = [
      item("need", "n1"),
      item("question", "q1"),
      item("decision", "d1", { status: "provisional", reversible: false }),
      item("decision", "d2", { status: "provisional", reversible: false }),
      item("need", "n2"),
    ];
    expect(groupRows(rows).map((r: Item) => r.id)).toEqual(["d1", "d2", "n1", "q1", "n2"]);
  });

  it("does not mutate its input", () => {
    const rows = [item("decision", "d1", { reversible: false }), item("need", "n1")];
    const ids = rows.map((r) => r.id);
    groupRows(rows);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });
});

/* ------------------------------------------------------------------ */
/* partitionNeedsHuman — needs-human tag band                          */
/* ------------------------------------------------------------------ */

describe("partitionNeedsHuman", () => {
  it("pins tagged items and preserves order in both partitions", () => {
    const rows = [
      { ...item("need", "a"), tags: ["docs"] },
      { ...item("need", "b"), tags: [NEEDS_HUMAN_TAG] },
      { ...item("warning", "c") },
      { ...item("need", "d"), tags: ["x", NEEDS_HUMAN_TAG] },
    ];
    const { pinned, rest } = partitionNeedsHuman(rows);
    expect(pinned.map((r: { id: string }) => r.id)).toEqual(["b", "d"]);
    expect(rest.map((r: { id: string }) => r.id)).toEqual(["a", "c"]);
  });

  it("handles items with no tags field and empty input", () => {
    expect(partitionNeedsHuman([])).toEqual({ pinned: [], rest: [] });
    const rows = [item("decision", "a"), item("question", "b")];
    const { pinned, rest } = partitionNeedsHuman(rows);
    expect(pinned).toEqual([]);
    expect(rest.length).toBe(2);
  });

  it("itemBadges adds a needs-human badge for tagged items", () => {
    const badges = itemBadges({ ...item("need", "a"), tags: [NEEDS_HUMAN_TAG] });
    expect(badges.some((b: { label: string }) => b.label === "needs human")).toBe(true);
    expect(itemBadges(item("need", "a")).some((b: { label: string }) => b.label === "needs human")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* splitUrls — URL linkification segments                              */
/* ------------------------------------------------------------------ */

describe("splitUrls", () => {
  it("splits text around http(s) URLs", () => {
    expect(splitUrls("see https://example.com/doc for details")).toEqual([
      { type: "text", value: "see " },
      { type: "url", value: "https://example.com/doc" },
      { type: "text", value: " for details" },
    ]);
  });

  it("excludes trailing sentence punctuation from the URL", () => {
    const segs = splitUrls("read http://a.io/spec.md.");
    expect(segs[1]).toEqual({ type: "url", value: "http://a.io/spec.md" });
    expect(segs[2]).toEqual({ type: "text", value: "." });
  });

  it("handles multiple URLs and URL-only strings", () => {
    const segs = splitUrls("https://a.io and https://b.io");
    expect(segs.map((s: { type: string }) => s.type)).toEqual(["url", "text", "url"]);
    expect(splitUrls("https://only.io")).toEqual([{ type: "url", value: "https://only.io" }]);
  });

  it("passes through text without URLs, empty, and non-string input", () => {
    expect(splitUrls("no links here")).toEqual([{ type: "text", value: "no links here" }]);
    expect(splitUrls("")).toEqual([]);
    expect(splitUrls(null)).toEqual([]);
    expect(splitUrls("file:///etc/passwd and /repo/doc.md")).toEqual([
      { type: "text", value: "file:///etc/passwd and /repo/doc.md" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* splitRepoPaths / splitLinkable / remoteBlobUrl                      */
/* ------------------------------------------------------------------ */

describe("splitRepoPaths", () => {
  it("matches repo-relative file paths and leaves surrounding text", () => {
    expect(splitRepoPaths("review docs/TRIAGE-SPEC.md before release")).toEqual([
      { type: "text", value: "review " },
      { type: "path", value: "docs/TRIAGE-SPEC.md" },
      { type: "text", value: " before release" },
    ]);
  });

  it("does not match version numbers, bare directories, or dotted segments", () => {
    expect(splitRepoPaths("superpowers/6.1.1 and src/ alone")).toEqual([
      { type: "text", value: "superpowers/6.1.1 and src/ alone" },
    ]);
    expect(splitRepoPaths(".twining/config.yml")).toEqual([
      // leading dot segment is not a valid first-segment start, so only the
      // non-dotted tail could match — config.yml alone has no slash
      { type: "text", value: ".twining/config.yml" },
    ]);
  });

  it("stops at trailing punctuation and line-ref suffixes", () => {
    const segs = splitRepoPaths("see src/engine/triage.ts:73.");
    expect(segs[1]).toEqual({ type: "path", value: "src/engine/triage.ts" });
    expect(segs[2]).toEqual({ type: "text", value: ":73." });
  });
});

describe("splitLinkable", () => {
  it("URLs win over path matching inside them", () => {
    const segs = splitLinkable("https://github.com/x/y/blob/main/docs/a.md and docs/b.md");
    expect(segs[0]).toEqual({ type: "url", value: "https://github.com/x/y/blob/main/docs/a.md" });
    expect(segs[segs.length - 1]).toEqual({ type: "path", value: "docs/b.md" });
  });
});

describe("remoteBlobUrl", () => {
  it("builds a blob URL from web_url + branch + encoded path", () => {
    expect(remoteBlobUrl({ web_url: "https://github.com/a/b", branch: "feat/triage" }, "docs/TRIAGE-SPEC.md")).toBe(
      "https://github.com/a/b/blob/feat%2Ftriage/docs/TRIAGE-SPEC.md",
    );
  });

  it("returns null without usable info", () => {
    expect(remoteBlobUrl(null, "docs/a.md")).toBeNull();
    expect(remoteBlobUrl({ web_url: null, branch: "main" }, "docs/a.md")).toBeNull();
    expect(remoteBlobUrl({ web_url: "https://x", branch: null }, "docs/a.md")).toBeNull();
  });
});
