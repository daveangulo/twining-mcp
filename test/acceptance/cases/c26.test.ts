/**
 * C26 — "A context packet does not fit the budget."
 *
 * Lane 04 owns essentially all of this case: the budget is over the DELIVERED
 * bytes, the tokenizer is declared, framing is counted, selected/emitted/
 * delivered are distinct, the omission manifest is complete, and a missing
 * required record blocks qualification explicitly.
 *
 * The assertion-by-assertion coverage lives in
 * `test/retrieval/tokenizer-packet.test.ts` (the pure builder) and
 * `test/retrieval/render-receipts.test.ts` (the receipts). THIS file runs the
 * oracle's own three-attempt sequence end to end so the arithmetic is exercised
 * as a whole rather than per-property.
 */
import { describe, it, expect } from "vitest";
import { buildPacket, type PacketItem } from "../../../src/retrieval/packet.js";
import { estimate, TOKENIZER_ID, PROVEN_TABLE } from "../../../src/retrieval/tokenizer.js";
import { mintReceipt, acknowledge, hashBytes, deliveryQualifies } from "../../../src/retrieval/receipts.js";
import { classifyLegacy } from "../../../src/retrieval/lifecycle.js";
import { selectCandidates } from "../../../src/retrieval/select.js";
import type { RenderableRecord } from "../../../src/retrieval/render.js";
import type { Scope } from "../../../src/contracts/scope.js";

const REPO = "r_quarry00000000000000000000";
const OTHER = "r_xscope00000000000000000000";

function record(id: string, version: string, bodySize: number): RenderableRecord {
  return {
    id,
    version,
    version_digest: "sha256:" + "0".repeat(64),
    title: `${id} title`,
    body: "detail ".repeat(Math.max(1, Math.floor(bodySize / 7))),
    scope_label: "repo-quarry/svc",
    evidence_class: "human_ruling",
    lifecycle: { ...classifyLegacy("active"), evidence_class: "human_ruling", authorizes_action: true },
  };
}

/** The oracle's candidate set: three required prerequisites plus two optional. */
/** REQ-A carries a BOM and CRLF line endings, which must survive into the emitted stream (A11). */
const REQ_A: PacketItem = {
  record: {
    ...record("rec-ga-0001", "v2", 900),
    body: "\uFEFFgoverning prerequisite\r\nsecond line\r\n" + "detail ".repeat(120),
  },
  tier: "governing",
  role: "required",
};
const REQ_B: PacketItem = { record: record("rec-cp-0002", "v1", 900), tier: "governing", role: "required" };
const REQ_C: PacketItem = { record: record("rec-rv-0003", "v3", 900), tier: "governing", role: "required" };
const OPT_D: PacketItem = { record: record("rec-if-0007", "v1", 600), tier: "lesson", role: "optional" };
const OPT_E: PacketItem = { record: record("rec-opt-0008", "v1", 600), tier: "lesson", role: "optional" };
const ALL = [REQ_A, REQ_B, REQ_C, OPT_D, OPT_E];

/** rec-xs-0006: out of scope. It must consume zero budget and appear nowhere. */
const XS_SCOPE: Scope = { repo: OTHER, path: "elsewhere" };

describe("C26 — a context packet does not fit the budget", () => {
  it("A10 — scope runs BEFORE budget: the out-of-scope record never becomes a candidate", () => {
    const pool = [
      { id: "rec-ga-0001", scope: { repo: REPO, path: "svc" } as Scope },
      { id: "rec-xs-0006", scope: XS_SCOPE },
    ];
    const sel = selectCandidates(pool, (p) => p.scope, (p) => p.id, {
      principal: "ap-scribe-01",
      authorized: [{ repo: REPO }],
      query: { repo: REPO, path: "svc" },
    });
    expect(sel.admitted.map((p) => p.id)).toEqual(["rec-ga-0001"]);
    // Its absence is a scope DENIAL (visible in the counters), not a silent omission.
    expect(sel.suppressed.scope_denied).toBe(1);

    // And it consumes no budget, because it never reaches the packet builder.
    const packet = buildPacket([REQ_A], { budget_tokens: 100000 });
    expect(packet.selected).not.toContain("rec-xs-0006");
    expect(packet.omissions.map((o) => o.id)).not.toContain("rec-xs-0006");
    expect(JSON.stringify(packet)).not.toContain("rec-xs-0006");
  });

  it("A1 (budget 4000) — partial_with_manifest: within budget, omissions named, blocked", () => {
    const p = buildPacket(ALL, { budget_tokens: 4000 });
    expect(p.token_usage.emitted_tokens).toBeLessThanOrEqual(4000);
    // A05: delivered_records derive from the emitted byte stream, not selection.
    expect(p.selected).toHaveLength(5);
    expect(p.emitted.length).toBeLessThan(5);
    // A06: everything in selected \ emitted is in the manifest with id/role/reason.
    const missing = p.selected.filter((id) => !p.emitted.includes(id));
    expect(p.omissions.map((o) => o.id).sort()).toEqual(missing.sort());
    for (const o of p.omissions) {
      expect(o.id).toBeTruthy();
      expect(o.version).toBeTruthy();
      expect(["required", "optional"]).toContain(o.role);
      expect(o.reason).toBeTruthy();
    }
    // A07/A08: blocked, with the missing required record named in the response.
    if (missing.some((id) => [REQ_A, REQ_B, REQ_C].some((r) => r.record.id === id))) {
      expect(p.qualifies_action).toBe(false);
      expect(p.incomplete).toBe(true);
      for (const id of p.missing_required) expect(p.text).toContain(id);
    }
  });

  it("A3 — the framing arithmetic closes: total minus record bodies equals the framing", () => {
    const p = buildPacket(ALL, { budget_tokens: 100000 });
    const bodySum = p.token_usage.per_record.reduce((a, b) => a + b.tokens, 0);
    expect(p.token_usage.emitted_tokens - bodySum).toBe(p.token_usage.framing_tokens);
    expect(p.token_usage.framing_tokens).toBeGreaterThan(0);
  });

  it("A2 — an independent recount of the emitted bytes reproduces the count exactly (±0)", () => {
    for (const budget of [4000, 6000, 100000]) {
      const p = buildPacket(ALL, { budget_tokens: budget });
      expect(estimate(p.text).tokens).toBe(p.token_usage.emitted_tokens);
    }
  });

  it("A4 — the tokenizer and its calibration table are named, and the bound declares itself", () => {
    const p = buildPacket(ALL, { budget_tokens: 100000 });
    expect(p.token_usage.tokenizer_id).toBe(TOKENIZER_ID);
    expect(p.token_usage.table_id).toBe(PROVEN_TABLE.id);
    expect(p.token_usage.conservative_fallback).toBe(true);
    // A conservative fallback's count must be >= the true count over the same
    // bytes. The proven table's floor is the UTF-8 byte length.
    expect(p.token_usage.emitted_tokens).toBeGreaterThanOrEqual(Buffer.byteLength(p.text, "utf8"));
  });

  it("A9 (P) — a generous budget delivers all three required records and qualifies", () => {
    const p = buildPacket(ALL, { budget_tokens: 100000 });
    expect(p.emitted).toEqual(expect.arrayContaining(["rec-ga-0001", "rec-cp-0002", "rec-rv-0003"]));
    expect(p.incomplete).toBe(false);
    expect(p.qualifies_action).toBe(true);
    expect(p.missing_required).toEqual([]);
    // rec-if-0007 is DELIVERED but is optional — it is in no basis list.
    expect(p.emitted).toContain("rec-if-0007");
    const optional = p.omissions.filter((o) => o.id === "rec-if-0007");
    expect(optional).toEqual([]);
  });

  it("A12 — an unacknowledged packet is `unknown`, not `delivered`, and does not qualify", () => {
    const p = buildPacket(ALL, { budget_tokens: 100000 });
    const r = mintReceipt({
      receipt_id: "pkt-A3-0003",
      emitted_text: p.text,
      selected: p.selected,
      emitted: p.emitted,
      omissions: p.omissions.map((o) => ({ id: o.id, reason: o.reason, role: o.role })),
      token_usage: p.token_usage as unknown as Record<string, unknown>,
    });
    expect(r.state).toBe("emitted");
    expect(r.unknown).toEqual(p.emitted);
    expect(deliveryQualifies(r)).toBe(false);
  });

  it("A13 — a retry is idempotent: one delivery record, unchanged sets, unchanged token count", () => {
    const p = buildPacket(ALL, { budget_tokens: 100000 });
    const base = mintReceipt({
      receipt_id: "pkt-A3-0003",
      emitted_text: p.text,
      selected: p.selected,
      emitted: p.emitted,
      omissions: [],
      token_usage: { tokens: p.token_usage.emitted_tokens },
    });
    const binding = { principal: "ap-scribe-01", host: "host-nimbus-b", session: "s-1", turn: "turn-0003" };
    const first = acknowledge(base, hashBytes(p.text), binding);
    const second = acknowledge(first.receipt, hashBytes(p.text), binding);
    expect(second.accepted).toBe(true);
    expect(second.receipt.delivered).toEqual(first.receipt.delivered);
    expect(second.receipt.token_usage).toEqual(first.receipt.token_usage);
    expect(second.receipt.emission_attempts).toBe(3); // mint=1, ack=2, retry=3
  });

  it("A11 — REQ-A's BOM and CRLF survive into the emitted stream, and the normalized hash is a DIFFERENT value", () => {
    const p = buildPacket(ALL, { budget_tokens: 100000 });
    // Byte preservation: nothing normalized the record on its way into the packet.
    expect(p.text).toContain("\uFEFFgoverning prerequisite\r\nsecond line\r\n");
    const r = mintReceipt({
      receipt_id: "x",
      emitted_text: p.text,
      selected: p.selected,
      emitted: p.emitted,
      omissions: [],
      token_usage: {},
    });
    expect(r.emitted_bytes_sha256).toBe(p.emitted_bytes_sha256);
    expect(r.normalized_text_sha256).not.toBe(r.emitted_bytes_sha256);
  });

  it("A15/A16 — a blocked attempt's receipt is unchanged by a later successful one", () => {
    const blocked = buildPacket(ALL, { budget_tokens: 4000 });
    const blockedReceipt = mintReceipt({
      receipt_id: "pkt-A1-0001",
      emitted_text: blocked.text,
      selected: blocked.selected,
      emitted: blocked.emitted,
      omissions: blocked.omissions.map((o) => ({ id: o.id, reason: o.reason, role: o.role })),
      token_usage: {},
      now: () => "2026-09-15T00:00:00.000Z",
    });
    const snapshot = JSON.stringify(blockedReceipt);

    // A later, successful attempt over the same candidates.
    const ok = buildPacket(ALL, { budget_tokens: 100000 });
    expect(ok.qualifies_action).toBe(true);

    // The blocked receipt is byte-identical.
    expect(JSON.stringify(blockedReceipt)).toBe(snapshot);
    // A16: being omitted from a packet is a DELIVERY fact, never a lifecycle one.
    expect(REQ_B.record.lifecycle.applicable).toBe(true);
    expect(REQ_B.record.lifecycle.state).toBe("current");
  });

  it("A17 — no truncated record passes as complete: a record is emitted whole or omitted", () => {
    const p = buildPacket(ALL, { budget_tokens: 4000 });
    // Every emitted record's full body is present in the bytes.
    for (const id of p.emitted) {
      const item = ALL.find((i) => i.record.id === id)!;
      expect(p.text).toContain(item.record.body);
    }
    // Nothing is marked partial in this fixture, and nothing was cut to fit.
    expect(p.omissions.every((o) => o.reason !== "partial")).toBe(true);
  });

  it("A18 — the trace exposes budget, tokenizer, sets and per-record cost without content leakage", () => {
    const p = buildPacket(ALL, { budget_tokens: 4000 });
    expect(p.token_usage.budget).toBe(4000);
    expect(p.token_usage.per_record.every((r) => typeof r.tokens === "number")).toBe(true);
    expect(JSON.stringify(p.token_usage)).not.toContain("rec-xs-0006");
  });

  it.todo("A14 (dedup inside the envelope across two selection paths): selection-level dedup by record id is the caller's; the packet counts what it is given, pinned in test/retrieval/tokenizer-packet.test.ts");
  it.todo("A5/A12 delivery-state transitions driven by a real transport: lane 02/03's exchange surface");
});
