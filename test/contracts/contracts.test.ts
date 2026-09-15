/**
 * Executable contract tests for src/contracts (ADR docs/adr/2026-09-foundation-contracts.md).
 * Positive fixtures prove the instrument accepts valid events; negative fixtures
 * prove each rejection code fires for the reason it exists.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeEventDigest,
  digestOf,
  validateEvent,
  generateKeypair,
  signEvent,
  verifyEventSignature,
  scopeMatches,
  scopeGoverns,
  pathCovers,
  successorMayApply,
  canTransition,
  mintEventId,
  mintPrincipalId,
  mintHostId,
  mintKeyId,
  mintRepoId,
  ENVELOPE_V,
  type EventInput,
} from "../../src/contracts/index.js";

const REPO = mintRepoId();
const HOST = mintHostId();
const AGENT = mintPrincipalId();
const HUMAN = mintPrincipalId();
const HUMAN_KEY = mintKeyId();
const SHA = "a".repeat(40);

function base(overrides: Partial<EventInput> = {}): Record<string, unknown> {
  const id = mintEventId();
  const ev: Record<string, unknown> = {
    v: ENVELOPE_V,
    id,
    kind: "created",
    record: { type: "decision", id },
    scope: { repo: REPO, path: "src/auth/" },
    producer: { principal: AGENT, kind: "agent", host: HOST, asserted_actor: "main" },
    source: { repo: REPO, branch: "feature-x", commit: SHA, dirty: false },
    parents: [],
    evidence_class: "proposal",
    occurred_at: "2026-09-15T20:00:00.000Z",
    payload: { summary: "Use ULIDs for event ids", rationale: "sortable and unique", confidence: "high" },
    ...overrides,
  };
  ev.digest = computeEventDigest(ev);
  return ev;
}

describe("canonical bytes and digests", () => {
  it("key order and whitespace do not change the digest; array order does", () => {
    const a = { b: 1, a: [1, 2], c: { z: "x", y: null } };
    const b = { c: { y: null, z: "x" }, a: [1, 2], b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(digestOf(a)).toBe(digestOf(b));
    expect(digestOf({ a: [2, 1] })).not.toBe(digestOf({ a: [1, 2] }));
    expect(canonicalize({ a: 1, u: undefined })).toBe('{"a":1}');
  });

  it("the file bytes, the canonical bytes and the payload are different things", () => {
    const ev = base();
    const pretty = JSON.stringify(ev, null, 2);
    const reparsed = JSON.parse(pretty) as Record<string, unknown>;
    expect(computeEventDigest(reparsed)).toBe(ev.digest); // digest survives pretty-printing
    expect(digestOf(pretty)).not.toBe(ev.digest); // hashing the file text is a different value
  });
});

describe("validateEvent — positive controls", () => {
  it("accepts a proposal decision from MCP", () => {
    const r = validateEvent(base(), { ingress: "mcp" });
    expect(r.ok).toBe(true);
  });

  it("accepts a lifecycle event whose target is its record", () => {
    const target = mintEventId();
    const ev = base({ kind: "superseded", record: { type: "decision", id: target }, payload: { target, by: mintEventId(), reason: "replaced" } } as never);
    const r = validateEvent(ev, { ingress: "cli" });
    expect(r.ok).toBe(true);
  });

  it("accepts a receipt", () => {
    const ev = base({ kind: "receipt", record: undefined, payload: { stage: "admitted", consumer: AGENT, events: [mintEventId()] } } as never);
    delete (ev as Record<string, unknown>).record;
    (ev as Record<string, unknown>).digest = computeEventDigest(ev);
    expect(validateEvent(ev, { ingress: "adapter" }).ok).toBe(true);
  });

  it("accepts a signed ruling from the ceremony and from import when the key is a known human key", () => {
    const kp = generateKeypair();
    const id = mintEventId();
    const ev = base({
      id, kind: "created", record: { type: "ruling", id },
      producer: { principal: HUMAN, kind: "human", host: HOST },
      evidence_class: "human_ruling",
      payload: { statement: "Reset tokens expire in 15 minutes" },
    } as never);
    ev.sig = { alg: "ed25519", key: HUMAN_KEY, value: signEvent(ev, kp.privateKeyPkcs8Pem) };
    const opts = { resolveKey: (k: string) => (k === HUMAN_KEY ? kp.publicKeySpkiBase64 : undefined), humanKeyIds: new Set([HUMAN_KEY]) };
    expect(validateEvent(ev, { ingress: "ceremony", ...opts }).ok).toBe(true);
    expect(validateEvent(ev, { ingress: "import", ...opts }).ok).toBe(true);
    expect(verifyEventSignature(ev, (ev.sig as { value: string }).value, kp.publicKeySpkiBase64)).toBe(true);
  });

  it("accepts a legacy_unverified event from migration with a legacy block", () => {
    const ev = base({ evidence_class: "legacy_unverified", legacy: { derived_from_legacy_snapshot: true, legacy_status: "active" } } as never);
    expect(validateEvent(ev, { ingress: "migration" }).ok).toBe(true);
  });
});

describe("validateEvent — rejections fire for their reason", () => {
  const code = (raw: unknown, ingress: Parameters<typeof validateEvent>[1]["ingress"] = "mcp") => {
    const r = validateEvent(raw, { ingress });
    return r.ok ? "OK" : r.code;
  };

  it("tampered payload → DIGEST_MISMATCH", () => {
    const ev = base();
    (ev.payload as Record<string, unknown>).summary = "Use UUIDs";
    expect(code(ev)).toBe("DIGEST_MISMATCH");
  });

  it("model cannot mint a ruling through MCP or CLI → CLASS_NOT_ALLOWED_ON_INGRESS", () => {
    const id = mintEventId();
    const ev = base({ id, record: { type: "ruling", id }, evidence_class: "human_ruling", payload: { statement: "x" } } as never);
    expect(code(ev, "mcp")).toBe("CLASS_NOT_ALLOWED_ON_INGRESS");
    expect(code(ev, "cli")).toBe("CLASS_NOT_ALLOWED_ON_INGRESS");
    expect(code(ev, "adapter")).toBe("CLASS_NOT_ALLOWED_ON_INGRESS");
  });

  it("MCP cannot claim verified_observation or human_statement", () => {
    expect(code(base({ evidence_class: "verified_observation" } as never))).toBe("CLASS_NOT_ALLOWED_ON_INGRESS");
    expect(code(base({ evidence_class: "human_statement" } as never))).toBe("CLASS_NOT_ALLOWED_ON_INGRESS");
  });

  it("an imported unsigned ruling → SIGNATURE_REQUIRED; a bad signature → SIGNATURE_INVALID; unknown signer → SIGNER_UNKNOWN", () => {
    const id = mintEventId();
    const ev = base({ id, record: { type: "ruling", id }, producer: { principal: HUMAN, kind: "human", host: HOST }, evidence_class: "human_ruling", payload: { statement: "x" } } as never);
    expect(code(ev, "import")).toBe("SIGNATURE_REQUIRED");
    const kp = generateKeypair();
    const other = generateKeypair();
    ev.sig = { alg: "ed25519", key: HUMAN_KEY, value: signEvent(ev, other.privateKeyPkcs8Pem) };
    const r1 = validateEvent(ev, { ingress: "import", resolveKey: () => kp.publicKeySpkiBase64, humanKeyIds: new Set([HUMAN_KEY]) });
    expect(r1.ok ? "OK" : r1.code).toBe("SIGNATURE_INVALID");
    const r2 = validateEvent(ev, { ingress: "import", resolveKey: () => undefined });
    expect(r2.ok ? "OK" : r2.code).toBe("SIGNER_UNKNOWN");
  });

  it("a ruling signed by an AGENT key is not a ruling → SIGNATURE_INVALID", () => {
    const kp = generateKeypair();
    const id = mintEventId();
    const ev = base({ id, record: { type: "ruling", id }, producer: { principal: HUMAN, kind: "human", host: HOST }, evidence_class: "human_ruling", payload: { statement: "x" } } as never);
    const agentKey = mintKeyId();
    ev.sig = { alg: "ed25519", key: agentKey, value: signEvent(ev, kp.privateKeyPkcs8Pem) };
    const r = validateEvent(ev, { ingress: "import", resolveKey: () => kp.publicKeySpkiBase64, humanKeyIds: new Set([HUMAN_KEY]) });
    expect(r.ok ? "OK" : r.code).toBe("SIGNATURE_INVALID");
  });

  it("unknown kind → UNKNOWN_KIND; unknown top-level key → SCHEMA; wrong envelope version → ENVELOPE_VERSION_UNSUPPORTED", () => {
    expect(code(base({ kind: "annotated" } as never))).toBe("UNKNOWN_KIND");
    const ev = base();
    ev.extra = true;
    ev.digest = computeEventDigest(ev);
    expect(code(ev)).toBe("SCHEMA");
    const v = base();
    v.v = 4;
    v.digest = computeEventDigest(v);
    expect(code(v)).toBe("ENVELOPE_VERSION_UNSUPPORTED");
  });

  it("lifecycle payload target must equal record.id → TARGET_RECORD_MISMATCH; strict payloads refuse unknown keys", () => {
    const target = mintEventId();
    const ev = base({ kind: "promoted", record: { type: "decision", id: target }, payload: { target: mintEventId() } } as never);
    expect(code(ev)).toBe("TARGET_RECORD_MISMATCH");
    const ev2 = base({ kind: "promoted", record: { type: "decision", id: target }, payload: { target, surprise: 1 } } as never);
    expect(code(ev2)).toBe("SCHEMA");
  });

  it("revocation is ruling-only; a legacy block outside migration is refused", () => {
    const target = mintEventId();
    expect(code(base({ kind: "revoked", record: { type: "ruling", id: target }, payload: { target, reason: "r" } } as never))).toBe("RECORD_TYPE_CLASS_MISMATCH");
    expect(code(base({ legacy: { derived_from_legacy_snapshot: true } } as never), "mcp")).toBe("LEGACY_FLAG_NOT_ALLOWED");
  });

  it("scope without repo must be global; a decision needs a summary and rationale", () => {
    expect(code(base({ scope: { path: "src/" } } as never))).toBe("SCHEMA");
    expect(code(base({ payload: { summary: "x" } } as never))).toBe("SCHEMA");
  });
});

describe("scope algebra", () => {
  it("path coverage is on segment boundaries", () => {
    expect(pathCovers("src/auth", "src/auth/reset/")).toBe(true);
    expect(pathCovers("src/auth/", "src/authz/")).toBe(false);
    expect(pathCovers("", "anything")).toBe(true);
    expect(pathCovers("src/auth/reset", "src/auth")).toBe(false);
  });

  it("retrieval match is bidirectional on path and exact on identities; global events match any repo", () => {
    const q = { repo: REPO, path: "src/auth/" };
    expect(scopeMatches(q, { repo: REPO, path: "src/" })).toBe(true);
    expect(scopeMatches(q, { repo: REPO, path: "src/auth/reset/" })).toBe(true);
    expect(scopeMatches(q, { repo: REPO, path: "src/billing/" })).toBe(false);
    expect(scopeMatches(q, { repo: mintRepoId(), path: "src/auth/" })).toBe(false); // another repo never matches
    expect(scopeMatches(q, { global: true, path: "src/auth/" })).toBe(true);
    expect(scopeMatches({ repo: REPO, task: "T1" }, { repo: REPO, task: "T2" })).toBe(false);
  });

  it("authority coverage is unidirectional and revision-bound", () => {
    expect(scopeGoverns({ repo: REPO, path: "src/auth/" }, { repo: REPO, path: "src/auth/reset/" })).toBe(true);
    expect(scopeGoverns({ repo: REPO, path: "src/auth/reset/" }, { repo: REPO, path: "src/auth/" })).toBe(false); // narrow never widens (C09)
    expect(scopeGoverns({ repo: REPO, path: "src/auth/" }, { repo: mintRepoId(), path: "src/auth/" })).toBe(false); // cross-repo never governs
    expect(scopeGoverns({ global: true }, { repo: REPO, path: "x/" })).toBe(true);
    expect(scopeGoverns({ repo: REPO, revision: { head: SHA } }, { repo: REPO, revision: { head: "b".repeat(40) } })).toBe(false); // review of A never qualifies B (C01)
    expect(scopeGoverns({ repo: REPO, revision: { head: SHA } }, { repo: REPO, revision: { head: SHA } })).toBe(true);
  });
});

describe("precedence and delivery", () => {
  it("a lower class never applies over a higher one; equal classes may", () => {
    expect(successorMayApply("human_ruling", "model_inference")).toBe(false);
    expect(successorMayApply("model_inference", "human_ruling")).toBe(true);
    expect(successorMayApply("proposal", "model_inference")).toBe(true);
    expect(successorMayApply("verified_observation", "legacy_unverified")).toBe(false);
  });

  it("delivery states move forward; rejected is terminal; injected repeats per turn", () => {
    expect(canTransition("local_persisted", "exported")).toBe(true);
    expect(canTransition("received", "admitted")).toBe(true);
    expect(canTransition("received", "projected")).toBe(false);
    expect(canTransition("rejected", "admitted")).toBe(false);
    expect(canTransition("injected", "injected")).toBe(true);
    expect(canTransition("quarantined", "admitted")).toBe(true);
  });
});
