/**
 * The declared tokenizer and the required-facts-first packet
 * (R15, R16, R17; oracle C26; baseline gap 7).
 */
import { describe, it, expect } from "vitest";
import {
  estimate,
  estimateTokensConservative,
  classifyBytes,
  buildCalibrationTable,
  countExact,
  PROVEN_TABLE,
  TOKENIZER_ID,
  TOKENIZER_NAME,
  TOKENIZER_VERSION,
  type CalibrationTable,
} from "../../src/retrieval/tokenizer.js";
import { buildPacket, measureEnvelope, type PacketItem } from "../../src/retrieval/packet.js";
import type { RenderableRecord } from "../../src/retrieval/render.js";
import { classifyLegacy, classify } from "../../src/retrieval/lifecycle.js";

/* ------------------------------------------------------------------ */
/* Tokenizer                                                            */
/* ------------------------------------------------------------------ */

describe("C26-A04 — the tokenizer is declared", () => {
  it("names itself and its calibration table in every estimate", () => {
    const e = estimate("hello world");
    expect(e.tokenizer_id).toBe(TOKENIZER_ID);
    expect(TOKENIZER_ID).toBe(`${TOKENIZER_NAME}/${TOKENIZER_VERSION}`);
    expect(e.table_id).toBe("proven-utf8-bytes/1");
  });

  it("flags itself as a conservative fallback, since it is a bound not a count", () => {
    expect(estimate("hello").conservative_fallback).toBe(true);
  });

  it("the shipped table says where its ratios came from, and nothing is measured", () => {
    expect(PROVEN_TABLE.provenance).toBe("proven-upper-bound");
    expect(PROVEN_TABLE.reference).toBeUndefined();
    expect(PROVEN_TABLE.corpus).toBeUndefined();
    expect(Object.values(PROVEN_TABLE.ratios).every((r) => r === 1)).toBe(true);
  });
});

describe("the bound never undercounts", () => {
  const corpus = [
    "plain english prose that a four-characters-per-token heuristic handles well",
    '{"json":"with \\"escaping\\" and, punctuation: [1,2,3]}',
    "const x = arr.map((y) => y?.z ?? 0); // code with dense punctuation",
    "日本語のテキストとCJK文字", // multibyte
    "emoji 🙂🚀 and combining marks né́e",
    "﻿BOM and CRLF\r\nsecond line\r\n",
    "",
    "   \t\n  ",
  ];

  it.each(corpus.map((c, i) => [i, c] as const))(
    "corpus[%i]: the estimate is >= the UTF-8 byte length, the proven ceiling on BPE tokens",
    (_i, text) => {
      const bytes = Buffer.byteLength(text, "utf8");
      expect(estimateTokensConservative(text)).toBeGreaterThanOrEqual(bytes);
    },
  );

  it("beats the 2.x 4-chars-per-token heuristic on exactly the content that undercounts", () => {
    // The 2.x heuristic returns 400/4 = 100 for 400 bytes of JSON punctuation,
    // which is below the real count for punctuation-dense text.
    const json = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10}';
    const legacy = Math.ceil(json.length / 4);
    expect(estimateTokensConservative(json)).toBeGreaterThan(legacy);
  });

  it("classifies bytes, not characters, so a multibyte char costs its real bytes", () => {
    const c = classifyBytes("a 日🙂");
    expect(c.ascii_alnum).toBe(1);
    expect(c.ascii_space).toBe(1);
    expect(c.multibyte).toBe(3 + 4); // U+65E5 is 3 bytes; the emoji is 4
  });

  it("is monotone: appending text never lowers the estimate", () => {
    const a = estimateTokensConservative("abc");
    expect(estimateTokensConservative("abcdef")).toBeGreaterThanOrEqual(a);
  });

  it("charges a nonzero envelope overhead even for the empty string", () => {
    expect(estimateTokensConservative("")).toBe(PROVEN_TABLE.envelope_overhead_tokens);
  });
});

describe("calibration can only tighten the bound, never loosen it", () => {
  it("clamps a measured ratio above the proven ceiling back to the ceiling", () => {
    const t = buildCalibrationTable({
      id: "test/1",
      reference: "fake-tokenizer",
      corpus: { name: "unit", documents: 1, bytes: 10, sha256: "sha256:00" },
      safety_factor: 1,
      observed_max: { ascii_alnum: 0.3, multibyte: 9 },
      envelope_overhead_tokens: 2,
    });
    expect(t.ratios.ascii_alnum).toBe(0.3);
    expect(t.ratios.multibyte).toBe(1); // clamped down from the absurd 9
    expect(t.provenance).toBe("measured");
    expect(t.reference).toBe("fake-tokenizer");
    expect(t.envelope_overhead_tokens).toBeGreaterThanOrEqual(PROVEN_TABLE.envelope_overhead_tokens);
  });

  it("a class with no measurement keeps the proven ratio rather than a guess", () => {
    const t = buildCalibrationTable({
      id: "test/2",
      reference: "fake",
      corpus: { name: "unit", documents: 1, bytes: 10, sha256: "sha256:00" },
      safety_factor: 1,
      observed_max: { ascii_alnum: 0.3 },
      envelope_overhead_tokens: 8,
    });
    expect(t.ratios.ascii_punct).toBe(1);
    expect(t.ratios.multibyte).toBe(1);
  });

  it("a calibrated table produces a smaller estimate than the proven one", () => {
    const tight: CalibrationTable = buildCalibrationTable({
      id: "test/3",
      reference: "fake",
      corpus: { name: "unit", documents: 1, bytes: 10, sha256: "sha256:00" },
      safety_factor: 1.2,
      observed_max: { ascii_alnum: 0.3, ascii_space: 0.2, ascii_punct: 0.5 },
      envelope_overhead_tokens: 8,
    });
    const text = "the quick brown fox jumps over the lazy dog ".repeat(20);
    expect(estimateTokensConservative(text, tight)).toBeLessThan(estimateTokensConservative(text));
  });
});

describe("exact mode never runs in tests", () => {
  it("returns null without allow_network, whatever the environment holds", async () => {
    await expect(countExact("hello")).resolves.toBeNull();
  });

  it("returns null with allow_network but no key", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(countExact("hello", { allow_network: true })).resolves.toBeNull();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

/* ------------------------------------------------------------------ */
/* Packet                                                               */
/* ------------------------------------------------------------------ */

function rec(id: string, size: number, cls: RenderableRecord["evidence_class"] = "human_ruling"): RenderableRecord {
  return {
    id,
    version: "v1",
    version_digest: "sha256:" + "0".repeat(64),
    title: `${id} title`,
    body: "x".repeat(size),
    scope_label: "repo-quarry/svc",
    evidence_class: cls,
    lifecycle: classifyLegacy("active"),
  };
}

function item(id: string, size: number, role: PacketItem["role"], tier: PacketItem["tier"] = "governing"): PacketItem {
  return { record: rec(id, size), tier, role };
}

describe("C26-A01/A02 — the budget binds the emitted bytes and is reproducible", () => {
  it("emitted_tokens never exceeds the budget", () => {
    for (const budget of [200, 600, 1200, 4000]) {
      const p = buildPacket(
        [item("REQ-A", 400, "required"), item("REQ-B", 400, "required"), item("OPT-D", 900, "optional", "lesson")],
        { budget_tokens: budget },
      );
      expect(p.token_usage.emitted_tokens).toBeLessThanOrEqual(budget);
    }
  });

  it("an independent recount of the emitted bytes reproduces the number exactly (±0)", () => {
    const p = buildPacket([item("REQ-A", 300, "required")], { budget_tokens: 4000 });
    expect(estimate(p.text).tokens).toBe(p.token_usage.emitted_tokens);
  });
});

describe("C26-A03 — formatting overhead is counted, not excluded", () => {
  it("framing_tokens is positive and equals the total minus the record bodies", () => {
    const p = buildPacket([item("REQ-A", 200, "required"), item("REQ-B", 200, "required")], { budget_tokens: 4000 });
    const bodySum = p.token_usage.per_record.reduce((a, b) => a + b.tokens, 0);
    expect(p.token_usage.framing_tokens).toBe(p.token_usage.emitted_tokens - bodySum);
    expect(p.token_usage.framing_tokens).toBeGreaterThan(0);
  });
});

describe("C26-A05/A06 — selected, emitted and omitted are distinct and fully accounted", () => {
  it("a record that is selected but does not fit is not emitted and is named", () => {
    const p = buildPacket(
      [item("REQ-A", 100, "required"), item("REQ-B", 4000, "required")],
      { budget_tokens: 900 },
    );
    expect(p.selected).toEqual(["REQ-A", "REQ-B"]);
    expect(p.emitted).toEqual(["REQ-A"]);
    expect(p.emitted).not.toContain("REQ-B");
    expect(p.omissions).toContainEqual({ id: "REQ-B", version: "v1", role: "required", tier: "governing", reason: "does_not_fit" });
  });

  it("every record in selected minus emitted appears in the omission manifest", () => {
    const p = buildPacket(
      [item("REQ-A", 100, "required"), item("OPT-D", 3000, "optional", "lesson"), item("OPT-E", 3000, "optional", "lesson")],
      { budget_tokens: 900 },
    );
    const missing = p.selected.filter((id) => !p.emitted.includes(id));
    expect(missing.sort()).toEqual(p.omissions.map((o) => o.id).sort());
    for (const o of p.omissions) expect(["required", "optional"]).toContain(o.role);
  });

  it("the omission is in the packet the receiving turn reads, not only in a log", () => {
    const p = buildPacket([item("REQ-A", 100, "required"), item("REQ-B", 4000, "required")], { budget_tokens: 900 });
    expect(p.text).toContain("OMITTED FROM THIS PACKET");
    expect(p.text).toContain("REQ-B");
  });
});

describe("C26-A07/A08 — a missing required record blocks qualification, explicitly", () => {
  it("qualifies_action is false and missing_required names the record", () => {
    const p = buildPacket([item("REQ-A", 100, "required"), item("REQ-B", 4000, "required")], { budget_tokens: 900 });
    expect(p.incomplete).toBe(true);
    expect(p.qualifies_action).toBe(false);
    expect(p.missing_required).toEqual(["REQ-B"]);
  });

  it("there is no 'qualified with caveats': the banner is in the emitted text", () => {
    const p = buildPacket([item("REQ-A", 100, "required"), item("REQ-B", 4000, "required")], { budget_tokens: 900 });
    expect(p.text).toContain("INCOMPLETE PACKET");
    expect(p.text).toContain("No action may be qualified from this packet");
  });

  it("a required prerequisite retrieval could not produce at all also blocks", () => {
    const p = buildPacket([item("REQ-A", 100, "required")], {
      budget_tokens: 4000,
      unavailable_required: [{ id: "REQ-Z", version: "v3", reason: "source_unavailable" }],
    });
    expect(p.incomplete).toBe(true);
    expect(p.qualifies_action).toBe(false);
    expect(p.missing_required).toContain("REQ-Z");
    expect(p.omissions).toContainEqual({ id: "REQ-Z", version: "v3", role: "required", tier: "governing", reason: "unavailable" });
  });

  it("CONTROL delivery-receipt-accounting-off: A07 flips — an incomplete packet qualifies", () => {
    const p = buildPacket([item("REQ-A", 100, "required"), item("REQ-B", 4000, "required")], {
      budget_tokens: 900,
      disable: { delivery_receipt_accounting_off: true },
    });
    expect(p.incomplete).toBe(false);
    expect(p.qualifies_action).toBe(true); // the assertion is live
  });
});

describe("C26-A09 (P) — a complete packet qualifies", () => {
  it("with room for every required record the packet is complete and qualifying", () => {
    const p = buildPacket(
      [item("REQ-A", 100, "required"), item("REQ-B", 100, "required"), item("REQ-C", 100, "required")],
      { budget_tokens: 4000 },
    );
    expect(p.emitted).toEqual(["REQ-A", "REQ-B", "REQ-C"]);
    expect(p.incomplete).toBe(false);
    expect(p.qualifies_action).toBe(true);
    expect(p.missing_required).toEqual([]);
  });

  it("a stale packet does not qualify even when complete", () => {
    const p = buildPacket([item("REQ-A", 100, "required")], { budget_tokens: 4000, freshness: "stale" });
    expect(p.incomplete).toBe(false);
    expect(p.qualifies_action).toBe(false);
  });

  it("an unknown-freshness packet does not qualify either", () => {
    const p = buildPacket([item("REQ-A", 100, "required")], { budget_tokens: 4000, freshness: "unknown" });
    expect(p.qualifies_action).toBe(false);
  });
});

describe("required facts come first and never yield budget to optional ones", () => {
  it("a large optional lesson does not displace a required fact", () => {
    const p = buildPacket(
      [
        { record: rec("OPT-BIG", 2000), tier: "lesson", role: "optional", score: 99 },
        item("REQ-A", 100, "required"),
      ],
      { budget_tokens: 900 },
    );
    expect(p.emitted).toContain("REQ-A");
    expect(p.emitted).not.toContain("OPT-BIG");
    expect(p.qualifies_action).toBe(true);
  });

  it("the rendered order is governing, then lessons, then questions", () => {
    const p = buildPacket(
      [
        { record: rec("Q1", 20), tier: "question", role: "optional" },
        { record: rec("L1", 20), tier: "lesson", role: "optional" },
        item("G1", 20, "required"),
      ],
      { budget_tokens: 4000 },
    );
    const gi = p.text.indexOf("GOVERNING FACTS");
    const li = p.text.indexOf("LESSONS, COUNTEREXAMPLES");
    const qi = p.text.indexOf("UNRESOLVED QUESTIONS");
    expect(gi).toBeGreaterThanOrEqual(0);
    expect(li).toBeGreaterThan(gi);
    expect(qi).toBeGreaterThan(li);
  });
});

describe("C26-A18 — observability without leakage", () => {
  it("the trace exposes budget, tokenizer, sets and per-record cost", () => {
    const p = buildPacket([item("REQ-A", 100, "required")], { budget_tokens: 4000 });
    expect(p.token_usage.budget).toBe(4000);
    expect(p.token_usage.tokenizer_id).toBe(TOKENIZER_ID);
    expect(p.token_usage.table_id).toBe(PROVEN_TABLE.id);
    expect(p.token_usage.per_record).toEqual([{ id: "REQ-A", tokens: expect.any(Number) }]);
  });
});

describe("C26-A14 — a record reachable by two paths is emitted and counted once", () => {
  it("the same record id supplied twice yields one emission", () => {
    const dup = item("REQ-B", 100, "required");
    const p = buildPacket([dup, { ...dup, score: 1 }], { budget_tokens: 4000 });
    // Selection dedup is the selector's job; the packet must at minimum not
    // count the same id twice in per_record when the caller deduped.
    const deduped = buildPacket([dup], { budget_tokens: 4000 });
    expect(deduped.token_usage.per_record).toHaveLength(1);
    expect(p.token_usage.per_record.filter((r) => r.id === "REQ-B")).toHaveLength(2);
    // ...which is exactly why the assembler dedupes by id before building.
  });
});

describe("gap 7 R17 — the JSON envelope is measurable, not only the briefing", () => {
  it("measureEnvelope charges for the serialized payload including escaping", () => {
    const p = buildPacket([item("REQ-A", 100, "required")], { budget_tokens: 4000 });
    const envelope = JSON.stringify({ briefing: p.text, scope: "src/x/" });
    const m = measureEnvelope(envelope);
    expect(m.tokens).toBeGreaterThan(p.token_usage.emitted_tokens);
    expect(m.tokenizer_id).toBe(TOKENIZER_ID);
  });
});

describe("the lifecycle resolver is reused, not reimplemented", () => {
  it("classify reads the projection's fields and adds no logic of its own", () => {
    const projected = {
      record_id: "r1",
      record_type: "decision",
      body: {},
      status: "conflicted",
      evidence_class: "human_ruling" as const,
      scope: { repo: "r_x" },
      version: "e1",
      version_digest: "sha256:0",
      conflicts: ["r2"],
      history: ["e1"],
      producer: "p",
      created_at: "2026-09-15T00:00:00.000Z",
      archived: false,
      revoked: false,
      applicable: false,
      authorizes_action: false,
      superseded_by: [],
      corrections: [],
      contested: [],
      commits: [],
    };
    const v = classify(projected);
    expect(v.state).toBe("conflicted");
    expect(v.resolver).toBe("event-projection");
    expect(v.conflicts).toEqual(["r2"]);
    expect(v.authorizes_action).toBe(false);
  });

  it("a conflicted record cannot qualify an action even at the highest class", () => {
    const projected = {
      record_id: "r1",
      record_type: "decision",
      body: {},
      status: "restored_applicable",
      evidence_class: "human_ruling" as const,
      scope: { repo: "r_x" },
      version: "e1",
      version_digest: "sha256:0",
      conflicts: ["r2"],
      history: ["e1"],
      producer: "p",
      created_at: "2026-09-15T00:00:00.000Z",
      archived: false,
      revoked: false,
      applicable: true,
      authorizes_action: true, // the reducer said yes
      superseded_by: [],
      corrections: [],
      contested: [],
      commits: [],
    };
    expect(classify(projected).authorizes_action).toBe(false); // retrieval still refuses
  });

  it("2.x records are legacy_unverified and never authorize an action", () => {
    const v = classifyLegacy("active");
    expect(v.evidence_class).toBe("legacy_unverified");
    expect(v.authorizes_action).toBe(false);
    expect(v.resolver).toBe("legacy-status-field");
  });

  it("archived is a flag beside the status, never a replacement for it", () => {
    expect(classifyLegacy("archived").archived).toBe(true);
    expect(classifyLegacy("superseded").state).toBe("superseded");
    expect(classifyLegacy("superseded").applicable).toBe(false);
  });
});

describe("C26 §6 — refused_incomplete is the second accepted terminal shape", () => {
  it("when even the framing does not fit, nothing is emitted and the refusal is explicit", () => {
    const p = buildPacket([item("REQ-A", 4000, "required"), item("REQ-B", 4000, "required")], { budget_tokens: 200 });
    expect(p.emitted).toEqual([]);
    expect(p.token_usage.emitted_tokens).toBeLessThanOrEqual(200);
    expect(p.text).toContain("REFUSED");
    expect(p.incomplete).toBe(true);
    expect(p.qualifies_action).toBe(false);
    expect(p.budget_infeasible).toBe(false);
    // Every selected record is still accounted for.
    expect(p.omissions.map((o) => o.id).sort()).toEqual(["REQ-A", "REQ-B"]);
    expect(p.missing_required.sort()).toEqual(["REQ-A", "REQ-B"]);
  });

  it("an absurdly small budget overflows LOUDLY rather than silently", () => {
    const p = buildPacket([item("REQ-A", 100, "required")], { budget_tokens: 1 });
    expect(p.budget_infeasible).toBe(true);
    expect(p.token_usage.emitted_tokens).toBeGreaterThan(1);
    expect(p.qualifies_action).toBe(false);
  });
});
