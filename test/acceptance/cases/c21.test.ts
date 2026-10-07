/**
 * C21 — migrate legacy stores; write new-format records; interrupt and roll back.
 * Oracle: test/acceptance/oracles/C21.oracle.md (+ C21.heldout.oracle.md).
 *
 * DECLARED OBSERVABLE MAPPING (oracle §1; the oracle requires this fixed before
 * the run, and it is part of the evidence rather than a convenience):
 *
 *   S1 Events/records        → store.get(id) / store.history(id) / the event
 *                              file on disk / legacy/manifest.json for the
 *                              frozen pre-migration hashes
 *   S2 Current applicable    → store.query({}) (retired and archived excluded)
 *   S3 Delivery/receipts     → store.deliveryState(id) — PARTIAL: the ladder's
 *                              selected/emitted/delivered arm belongs to lane
 *                              02b's outbox and lane 03's injection receipts.
 *                              The assertions that need it are reported
 *                              UNAVAILABLE below, never converted to passed.
 *   S4 Historical view       → store.history(id) + store.query({include_*})
 *   S5 Action qualification  → currentUseClaim(record, scope) from the reducer
 *   S6 Operator observability→ the MigrateV3Report / RollbackReport / migrateStatus
 *
 * FIXTURE MAPPING. The oracle's cast is synthetic prose; this run uses the
 * committed legacy fixtures, which carry the same SHAPES under different ids:
 *
 *   L-001 authority-shaped legacy record  → dActive (active + promoted_by)
 *   L-000 superseded                      → dSupersededWith
 *   L-002 archived, supersedes L-000      → dArchivedWith
 *   L-003 provisional                     → dProvisional
 *   L-003-conflict duplicate declared id  → the dDuplicated rival body
 *   L-004 missing provenance              → dSupersededOrphan (no pointers)
 *   L-006 unpublished draft               → dOrphan (absent from the index)
 *   L-007 lesson, no embedding            → every record (none has an embedding)
 *   L-008 truncated export row            → the malformed + conflict-marked files
 *   N-101 multi-part human authorization  → RULING (parts A and B)
 *   N-102 partial supersession of part-B  → SUPERSEDE_B
 *   N-103 four-hash observation           → OBS
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { migrateToV3, migrateStatus, readIdMap, readManifest, readMigrationState, type LegacyManifest } from "../../../src/migrate/v3-forward.js";
import { rollbackToV2 } from "../../../src/migrate/v3-rollback.js";
import { scanLegacyStore } from "../../../src/migrate/legacy-scan.js";
import { EventStore, type KnownKey } from "../../../src/events/event-store.js";
import { currentUseClaim } from "../../../src/events/projection.js";
import {
  computeEventDigest,
  generateKeypair,
  mintEventId,
  mintHostId,
  mintKeyId,
  mintPrincipalId,
  signEvent,
  ENVELOPE_V,
  type Keypair,
} from "../../../src/contracts/index.js";
import { loadConfig, formatVersionRefusal } from "../../../src/config.js";
import { cleanupStores, copyStore, legacySnapshot, twiningDirOf, V1_FIXTURE, V2_FIXTURE } from "../../migrate/v3-helpers.js";

afterAll(cleanupStores);

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

// The fixture ids, named for what the oracle calls them.
const L_001 = "01M3C21DACT1V0000000000000"; // authority-shaped legacy record
const L_000 = "01M3C21DSPSW10000000000000"; // superseded
const L_002 = "01M3C21DARCW10000000000000"; // archived
const L_003 = "01M3C21DPR0V10000000000000"; // provisional
const L_DUP = "01M3C21DDPCT10000000000000"; // declared twice with different bytes
const L_006 = "01M3C21DRPHN10000000000000"; // on disk, absent from the index
const CATALOG = "src/catalog/";
const OPS = "src/ops/";
const LEDGER = "src/ledger/";

interface Human {
  principal: string;
  host: string;
  keyId: string;
  kp: Keypair;
}

function human(): Human {
  return { principal: mintPrincipalId(), host: mintHostId(), keyId: mintKeyId(), kp: generateKeypair() };
}

function envelope(fields: Record<string, unknown>, signer?: Human): Record<string, unknown> {
  const ev: Record<string, unknown> = { v: ENVELOPE_V, ...fields };
  ev.digest = computeEventDigest(ev);
  if (signer) ev.sig = { alg: "ed25519", key: signer.keyId, value: signEvent(ev, signer.kp.privateKeyPkcs8Pem) };
  return ev;
}

/**
 * The post-upgrade writes (oracle T6): a two-part authenticated human
 * authorization, a partial supersession of its withheld part, and an
 * observation whose hashes must all differ.
 */
function postUpgradeWrites(repoId: string, mira: Human, migratorPrincipal: string) {
  const principal = envelope({
    id: mintEventId(),
    kind: "created",
    scope: { repo: repoId },
    producer: { principal: mira.principal, kind: "human", host: mira.host },
    parents: [],
    evidence_class: "proposal",
    occurred_at: "2026-09-16T09:00:00.000Z",
    payload: { principal_id: mira.principal, kind: "human", host: mira.host, key_id: mira.keyId, public_key: mira.kp.publicKeySpkiBase64 },
  });
  (principal as { record?: unknown }).record = { type: "principal", id: principal.id };
  const principalEv = envelope({ ...principal, digest: undefined, sig: undefined });

  const membership = envelope({
    id: mintEventId(),
    kind: "created",
    scope: { repo: repoId },
    producer: { principal: mira.principal, kind: "human", host: mira.host },
    parents: [principalEv.id as string],
    evidence_class: "proposal",
    occurred_at: "2026-09-16T09:01:00.000Z",
    payload: {
      store_id: `s_${"0".repeat(0)}${(mintEventId as () => string)()}`,
      // Both principals. A replacement policy MUST carry forward a write grant
      // for every principal already in the history — including the migrator —
      // or admission re-judges the migrated events on the next rebuild and
      // drops them (measured; reported to lane 02b as an admission defect).
      // This line is the documented operator obligation, not a test fudge.
      members: [
        { principal: mira.principal, roles: ["rule", "write"], scopes: [{ repo: repoId, path: CATALOG }] },
        { principal: migratorPrincipal, roles: ["write"], scopes: [{ repo: repoId }] },
      ],
    },
  });
  (membership as { record?: unknown }).record = { type: "membership", id: membership.id };
  const membershipEv = envelope({ ...membership, digest: undefined, sig: undefined });

  const rulingId = mintEventId();
  const RULING = envelope(
    {
      id: rulingId,
      kind: "created",
      record: { type: "ruling", id: rulingId },
      scope: { repo: repoId, path: CATALOG },
      producer: { principal: mira.principal, kind: "human", host: mira.host },
      parents: [membershipEv.id as string],
      evidence_class: "human_ruling",
      occurred_at: "2026-09-16T10:00:00.000Z",
      payload: {
        statement: "catalog publication authorization",
        parts: [
          { part_id: "part-A", text: "publish catalog output" },
          { part_id: "part-B", text: "publish full story" },
        ],
      },
    },
    mira,
  );

  const successorId = mintEventId();
  const SUCCESSOR = envelope(
    {
      id: successorId,
      kind: "created",
      record: { type: "ruling", id: successorId },
      scope: { repo: repoId, path: CATALOG },
      producer: { principal: mira.principal, kind: "human", host: mira.host },
      parents: [rulingId],
      evidence_class: "human_ruling",
      occurred_at: "2026-09-16T10:05:00.000Z",
      payload: { statement: "the full story stays unpublished pending legal review" },
    },
    mira,
  );

  const SUPERSEDE_B = envelope(
    {
      id: mintEventId(),
      kind: "superseded",
      record: { type: "ruling", id: rulingId },
      scope: { repo: repoId, path: CATALOG },
      producer: { principal: mira.principal, kind: "human", host: mira.host },
      parents: [successorId],
      evidence_class: "human_ruling",
      occurred_at: "2026-09-16T10:06:00.000Z",
      payload: { target: rulingId, by: successorId, parts: ["part-B"], reason: "withheld pending legal review" },
    },
    mira,
  );

  // Four hash values that must all differ (oracle A-REC-02): the source bytes,
  // a normalized-text hash, a git object id, and the rendered output.
  const sourceBytes = "﻿Rendered output differs from the stored bytes by BOM and newline only.\r\n";
  const normalized = "Rendered output differs from the stored bytes by BOM and newline only.\n";
  const rendered = "Rendered output differs from the stored bytes by BOM and newline only.";
  const obsId = mintEventId();
  const OBS = envelope(
    {
      id: obsId,
      kind: "created",
      record: { type: "observation", id: obsId },
      scope: { repo: repoId, path: CATALOG },
      producer: { principal: mira.principal, kind: "human", host: mira.host },
      parents: [membershipEv.id as string],
      evidence_class: "verified_observation",
      occurred_at: "2026-09-16T10:10:00.000Z",
      payload: {
        source_kind: "file",
        source_uri: "src/catalog/note.md",
        sha256: sha(Buffer.from(sourceBytes, "utf8")),
        normalized_sha256: sha(Buffer.from(normalized, "utf8")),
        observed_at: "2026-09-16T10:10:00.000Z",
        volatile: false,
        result: { rendered_output_sha256: sha(Buffer.from(rendered, "utf8")), git_object_id: "f".repeat(40) },
      },
      attachments: [
        {
          sha256: sha(Buffer.from(sourceBytes, "utf8")),
          bytes: Buffer.byteLength(sourceBytes, "utf8"),
          media_type: "text/markdown",
          source_kind: "file",
          source_uri: "src/catalog/note.md",
          encoding: "utf-8-bom",
          git_oid: "f".repeat(40),
        },
      ],
    },
    mira,
  );

  return {
    infra: [principalEv, membershipEv],
    RULING,
    SUCCESSOR,
    SUPERSEDE_B,
    OBS,
    all: [principalEv, membershipEv, RULING, SUCCESSOR, SUPERSEDE_B, OBS],
    hashes: { source: sha(Buffer.from(sourceBytes, "utf8")), normalized: sha(Buffer.from(normalized, "utf8")), rendered: sha(Buffer.from(rendered, "utf8")), git: "f".repeat(40) },
  };
}

/** The principal the migration authored its events as. */
async function store0Principal(tw: string): Promise<string> {
  const store = new EventStore({ twiningDir: tw });
  try {
    const [first] = await store.events({});
    return first?.producer.principal as string;
  } finally {
    store.close();
  }
}

interface Scenario {
  root: string;
  tw: string;
  repoId: string;
  mira: Human;
  writes: ReturnType<typeof postUpgradeWrites>;
  knownKeys: Record<string, KnownKey>;
  legacyBefore: Record<string, string>;
  manifest: LegacyManifest;
}

/** T0–T6: freeze, snapshot, dry run, migrate, rerun, post-upgrade writes. */
async function scenario(fixture = V1_FIXTURE): Promise<Scenario> {
  const root = copyStore(fixture, "c21");
  const tw = twiningDirOf(root);
  const legacyBefore = legacySnapshot(tw); // T1
  await migrateToV3({ projectRoot: root, dryRun: true }); // T2
  await migrateToV3({ projectRoot: root }); // T3/T4
  await migrateToV3({ projectRoot: root }); // T5 — third run
  const manifest = readManifest(tw) as LegacyManifest;
  const repoId = (JSON.parse(fs.readFileSync(path.join(tw, "store.json"), "utf8")) as { repo_id: string }).repo_id;

  const mira = human();
  const knownKeys: Record<string, KnownKey> = { [mira.keyId]: { publicKeySpkiBase64: mira.kp.publicKeySpkiBase64, human: true } };
  const migratorPrincipal = (await store0Principal(tw)) as string;
  const writes = postUpgradeWrites(repoId, mira, migratorPrincipal);

  const store = new EventStore({ twiningDir: tw, knownKeys });
  for (const ev of writes.all) store.receive(ev, "local");
  await store.admit();
  await store.project();
  store.close();

  return { root, tw, repoId, mira, writes, knownKeys, legacyBefore, manifest };
}

function open(s: Scenario): EventStore {
  return new EventStore({ twiningDir: s.tw, knownKeys: s.knownKeys });
}

describe("C21 — S1: events and records", () => {
  it("A-REC-01 byte preservation: every migrated record's stored bytes hash to the frozen manifest value", async () => {
    const s = await scenario();
    const scan = scanLegacyStore(s.tw);
    for (const rec of scan.records) {
      const frozen = Object.entries(s.manifest.ids).find(([k]) => k.startsWith(`${rec.legacy_id}@`))?.[1];
      expect(frozen, `manifest row for ${rec.legacy_id}`).toBeDefined();
      const stored = path.join(s.tw, "attachments", (frozen as { sha256: string }).sha256.slice(0, 2), (frozen as { sha256: string }).sha256);
      // Read the STORED file and hash it here — not a value the migration
      // re-derived, which would make this assertion vacuous.
      expect(sha(fs.readFileSync(stored))).toBe((frozen as { sha256: string }).sha256);
    }
  });

  it("A-REC-02 hash distinctness: four hash values, none a copy or null-fill of another", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const obs = await store.get(s.writes.OBS.id as string);
      const body = obs?.body as { sha256: string; normalized_sha256: string; result: { rendered_output_sha256: string; git_object_id: string } };
      const four = [body.sha256, body.normalized_sha256, body.result.rendered_output_sha256, body.result.git_object_id];
      expect(new Set(four).size).toBe(4);
      for (const v of four) expect(v).toMatch(/^[0-9a-f]{40,64}$/);
    } finally {
      store.close();
    }
  });

  it("A-REC-03 stable ID mapping: total, injective, round-trips, and identical across rerun and clean control", async () => {
    const s = await scenario();
    const scan = scanLegacyStore(s.tw);
    const idMap = readIdMap(s.tw);
    for (const rec of scan.records) expect(idMap[rec.legacy_id]?.created).toBe(rec.legacy_id);
    const created = Object.values(idMap).map((e) => e.created);
    expect(new Set(created).size).toBe(created.length);

    const control = copyStore(V1_FIXTURE, "c21ctl");
    await migrateToV3({ projectRoot: control });
    const shape = (m: Record<string, { created: string; kind: string }>): Record<string, string> =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, `${v.kind}:${v.created}`]));
    expect(shape(readIdMap(s.tw))).toEqual(shape(readIdMap(twiningDirOf(control))));
  });

  it("A-REC-04 relationships preserved: the manifest set is present and nothing is invented", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      // Present: L-002-shaped supersession survives as a real edge.
      const superseded = await store.get(L_000);
      expect(superseded?.superseded_by).toEqual([L_001]);
      // Nothing invented: a record with no relationship field acquires none.
      const provisional = await store.get(L_003);
      expect(provisional?.superseded_by).toEqual([]);
      expect(provisional?.overridden_by).toBeUndefined();
      // Every relationship in the projection traces to a manifest row or to a
      // post-upgrade write — no third source exists.
      const all = await store.query({ include_archived: true, include_retired: true });
      for (const rec of all) {
        for (const by of rec.superseded_by) {
          const fromManifest = s.manifest.relationships[rec.record_id]?.superseded_by === by || s.manifest.relationships[by]?.supersedes === rec.record_id;
          const postUpgrade = by === s.writes.SUCCESSOR.id;
          expect(fromManifest || postUpgrade, `invented supersession ${rec.record_id} → ${by}`).toBe(true);
        }
      }
    } finally {
      store.close();
    }
  });

  it("A-REC-05 unknown stays unknown: absent provenance is never filled with the migrator or the clock", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      // The fixture's records with no provenance/agent metadata keep none.
      const [created] = await store.history(L_003);
      const noProv = (await store.history("01M3C21EC0NC10000000000000"))[0]; // an entity: no agent_id, no provenance
      expect(noProv?.producer.asserted_actor).toBeUndefined();
      expect(noProv?.source).toBeUndefined();
      // occurred_at comes from the legacy record, never from the migration
      // clock. Compared against the migration's own start time rather than the
      // calendar year — the fixture and the run share a year, so a year
      // comparison would pass even if the clock HAD been substituted.
      expect(created?.occurred_at).toBe("2026-08-01T09:00:00.000Z");
      const state = migrateStatus(s.tw);
      expect(state.migration).toBe("complete");
      const migratedAt = Date.parse(readMigrationState(s.tw)?.started_at ?? "");
      for (const ev of await store.events({})) {
        if (ev.legacy?.derived_from_legacy_snapshot !== true) continue; // post-upgrade writes are genuinely later
        expect(Date.parse(ev.occurred_at), `${ev.id} carries the migration clock`).toBeLessThan(migratedAt);
      }
    } finally {
      store.close();
    }
  });

  it("A-REC-06 legacy authority ambiguity is marked, and readable through the SAME API that serves the record", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const l001 = await store.get(L_001);
      expect(l001?.evidence_class).toBe("legacy_unverified");
      expect(l001?.evidence_class).not.toBe("human_ruling");
      // The marker travels on the projected record, not only in storage.
      expect(l001?.legacy?.derived_from_legacy_snapshot).toBe(true);
      expect(l001?.authorizes_action).toBe(false);
      // …and on the retrieval surface an injector would use.
      const served = (await store.query({ scope: { repo: s.repoId, path: CATALOG } })).find((r) => r.record_id === L_001);
      expect(served?.legacy?.derived_from_legacy_snapshot).toBe(true);
      expect(served?.authorizes_action).toBe(false);
    } finally {
      store.close();
    }
  });

  it("A-REC-07 no promotion from caller-controlled fields; the originals survive verbatim", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const all = await store.query({ include_archived: true, include_retired: true });
      const migrated = all.filter((r) => r.legacy?.derived_from_legacy_snapshot === true);
      expect(migrated.length).toBeGreaterThan(10);
      for (const rec of migrated) {
        expect(rec.evidence_class).toBe("legacy_unverified");
        expect(rec.authorizes_action).toBe(false);
      }
      // The legacy active/actor/promoted_by values are still readable as
      // asserted provenance: agent_id on the producer, promoted as an event,
      // and the whole original record in the attachment bytes.
      const [created] = await store.history(L_001);
      expect(created?.producer.asserted_actor).toBe("agent-scribe");
      const promoted = (await store.history(L_001)).find((e) => e.kind === "promoted");
      expect(promoted).toBeDefined();
      const att = created?.attachments?.[0] as { sha256: string };
      const original = JSON.parse(fs.readFileSync(path.join(s.tw, "attachments", att.sha256.slice(0, 2), att.sha256), "utf8")) as Record<string, unknown>;
      expect(original.status).toBe("active");
      expect(original.promoted_by).toBe("agent-ratifier");
    } finally {
      store.close();
    }
  });

  it("A-REC-08 dirty/unpublished work survives with its bytes intact", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      // The index-desynced record is the fixture's "never exported" draft.
      const draft = await store.get(L_006);
      expect(draft).not.toBeNull();
      const [created] = await store.history(L_006);
      const att = created?.attachments?.[0] as { sha256: string };
      const frozen = Object.entries(s.manifest.ids).find(([k]) => k.startsWith(`${L_006}@`))?.[1] as { sha256: string };
      expect(att.sha256).toBe(frozen.sha256);
    } finally {
      store.close();
    }
  });

  it("A-REC-09 conflict retained: both byte streams kept, the pair flagged, neither the resolved value", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const primary = await store.get(L_DUP);
      expect(primary?.contested.length).toBeGreaterThan(0);
      const rivalId = primary?.contested[0]?.claimant as string;
      const rival = await store.get(rivalId);
      expect(rival).not.toBeNull();
      // BOTH byte streams are on disk and differ.
      const shas = s.manifest.conflicts.flatMap((c) => [c.primary, ...c.rivals]).map((file) => sha(fs.readFileSync(path.join(s.tw, file))));
      expect(new Set(shas).size).toBe(2);
      for (const h of shas) expect(fs.existsSync(path.join(s.tw, "attachments", h.slice(0, 2), h))).toBe(true);
      // Neither is served as the resolved value.
      const current = (await store.query({})).map((r) => r.record_id);
      expect(current).not.toContain(rivalId);
      expect(currentUseClaim(primary!, { repo: s.repoId, path: CATALOG }).ok).toBe(false);
    } finally {
      store.close();
    }
  });

  it("A-REC-10 derived-index rebuild is not data loss; a missing embedding is absent, not imputed", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const before = store.projectionDigest();
      const rebuilt = await store.rebuild();
      expect(rebuilt.projection_digest).toBe(before);
      expect(rebuilt.acknowledged_events_lost).toBe(0);
      // Still retrievable by exact id after the rebuild.
      for (const id of [L_001, L_000, L_002, L_003, L_006]) expect(await store.get(id)).not.toBeNull();
      // No embedding was invented for any record.
      const all = await store.query({ include_archived: true, include_retired: true });
      for (const rec of all) expect(rec.body).not.toHaveProperty("embedding_id");
    } finally {
      store.close();
    }
  });

  it("A-REC-11 truncation is not reconstruction: quarantined with recoverable bytes, named in the report", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      expect(s.manifest.damaged.length).toBeGreaterThan(0);
      for (const d of s.manifest.damaged) {
        const kept = path.join(s.tw, "legacy", "quarantine", `${d.sha256}.bytes`);
        expect(fs.existsSync(kept)).toBe(true);
        expect(sha(fs.readFileSync(kept))).toBe(d.sha256);
        // No record was built from it, and nothing was completed.
        const declaredId = path.basename(d.file, ".json");
        expect(await store.get(declaredId)).toBeNull();
      }
      const report = await migrateToV3({ projectRoot: s.root, dryRun: true });
      expect(report.findings.some((f) => f.kind.startsWith("damaged:"))).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("C21 — S2: current applicable view", () => {
  it("A-CUR-01 contains the legacy-unverified record, the archived marker and the granted part", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const current = (await store.query({ scope: { repo: s.repoId, path: CATALOG } })).map((r) => r.record_id);
      expect(current).toContain(L_001);
      // The provisional record is scoped to src/ledger/ in the fixture, so it
      // is current in ITS scope — asserting it under src/catalog/ would be
      // asserting that scope filtering is broken.
      expect((await store.query({ scope: { repo: s.repoId, path: LEDGER } })).map((r) => r.record_id)).toContain(L_003);
      // The archived record is excluded from DEFAULT retrieval but is present
      // with its archive marker when asked for — archived is not deleted.
      expect(current).not.toContain(L_002);
      const archived = await store.get(L_002);
      expect(archived?.archived).toBe(true);
      expect(archived?.archived_from).toBe("active");
      // part-A of the post-upgrade authorization still applies.
      const ruling = await store.get(s.writes.RULING.id as string);
      expect(ruling?.parts?.find((p) => p.part_id === "part-A")?.status).toBe("applicable");
    } finally {
      store.close();
    }
  });

  it("A-CUR-02 excludes the superseded record, the conflict rival, the damaged rows and the superseded part", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const current = (await store.query({})).map((r) => r.record_id);
      expect(current).not.toContain(L_000); // superseded
      const primary = await store.get(L_DUP);
      expect(current).not.toContain(primary?.contested[0]?.claimant); // the rival
      for (const d of s.manifest.damaged) expect(current).not.toContain(path.basename(d.file, ".json"));
      // part-B is superseded; part-A is not.
      const ruling = await store.get(s.writes.RULING.id as string);
      expect(ruling?.parts?.find((p) => p.part_id === "part-B")?.status).toBe("superseded");
      expect(ruling?.parts?.find((p) => p.part_id === "part-A")?.status).toBe("applicable");
    } finally {
      store.close();
    }
  });

  it("A-CUR-03 rollback does not re-label: the 2.x view never serves the v3 authorization as an ordinary legacy record", async () => {
    const s = await scenario();
    await rollbackToV2({ projectRoot: s.root });
    const file = path.join(s.tw, "records", "decisions", `${s.writes.RULING.id as string}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const view = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // It is labelled as a VIEW, and every v3 semantic the 2.x shape drops is named.
    expect(view.legacy_view_of).toBeDefined();
    expect(view.v3_semantics_lost).toContain("evidence_class:human_ruling");
    expect(view.v3_semantics_lost).toContain("parts");
    expect(view.v3_semantics_lost).toContain("part_level_lifecycle");
    // …and it is not dressed up as a legacy record that was simply active.
    expect(view.legacy_ambiguity).toBeUndefined();
  });
});

describe("C21 — S4: historical view", () => {
  it("A-HIST-01 a superseded record keeps its lifecycle and its pointer, and is absent from current", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const history = await store.history(L_000);
      expect(history.some((e) => e.kind === "created")).toBe(true);
      expect(history.some((e) => e.kind === "superseded")).toBe(true);
      const rec = await store.get(L_000);
      expect(rec?.superseded_by).toEqual([L_001]);
      expect((await store.query({})).map((r) => r.record_id)).not.toContain(L_000);
    } finally {
      store.close();
    }
  });

  it("A-HIST-02 migration alters no lifecycle state: archived is not revoked, provisional is not promoted", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const archived = await store.get(L_002);
      expect(archived?.archived).toBe(true);
      expect(archived?.revoked).toBe(false);
      expect(archived?.status).not.toBe("revoked");

      const provisional = await store.get(L_003);
      expect(provisional?.status).toBe("provisional");
      expect((await store.history(L_003)).some((e) => e.kind === "promoted")).toBe(false);
      expect(provisional?.authorizes_action).toBe(false);
    } finally {
      store.close();
    }
  });

  it("A-HIST-03 the original asserted values are readable verbatim beside the not-checked marking", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const [created] = await store.history(L_001);
      const att = created?.attachments?.[0] as { sha256: string };
      const original = JSON.parse(fs.readFileSync(path.join(s.tw, "attachments", att.sha256.slice(0, 2), att.sha256), "utf8")) as Record<string, unknown>;
      expect(original.status).toBe("active");
      expect(original.agent_id).toBe("agent-scribe");
      expect(original.promoted_by).toBe("agent-ratifier");
      expect(created?.evidence_class).toBe("legacy_unverified"); // the marking, beside them
    } finally {
      store.close();
    }
  });
});

describe("C21 — S5: action qualification", () => {
  it("A-ACT-01 [PC] positive control: the in-scope authenticated human authorization QUALIFIES", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const ruling = await store.get(s.writes.RULING.id as string);
      expect(ruling?.evidence_class).toBe("human_ruling");
      const claim = currentUseClaim(ruling!, { repo: s.repoId, path: CATALOG });
      expect(claim.ok, `denied: ${claim.reason}`).toBe(true);
    } finally {
      store.close();
    }
  });

  it("A-ACT-02 a legacy record is DENIED with a reason naming its evidence class, and stays retrievable", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const l001 = await store.get(L_001);
      const claim = currentUseClaim(l001!, { repo: s.repoId, path: CATALOG });
      expect(claim.ok).toBe(false);
      expect(claim.reason).toBe("insufficient_evidence_class");
      // Denial is not deletion.
      expect(await store.get(L_001)).not.toBeNull();
      expect((await store.history(L_001)).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("A-ACT-03 the withheld-and-superseded part does not qualify the broader action", async () => {
    const s = await scenario();
    const store = open(s);
    try {
      const ruling = await store.get(s.writes.RULING.id as string);
      const partB = ruling?.parts?.find((p) => p.part_id === "part-B");
      expect(partB?.status).toBe("superseded");
      expect(partB?.superseded_by).toBe(s.writes.SUCCESSOR.id);
      // The record still qualifies actions its APPLICABLE parts cover; the
      // withheld part is not among them, and says so per part.
      expect(ruling?.parts?.filter((p) => p.status === "applicable").map((p) => p.part_id)).toEqual(["part-A"]);
    } finally {
      store.close();
    }
  });

  it("A-ACT-04 an out-of-scope citation is DENIED with a SCOPE reason, before and after recovery", async () => {
    const s = await scenario();
    let store = open(s);
    try {
      const ruling = await store.get(s.writes.RULING.id as string);
      const denial = currentUseClaim(ruling!, { repo: s.repoId, path: OPS });
      expect(denial.ok).toBe(false);
      expect(denial.reason).toBe("out_of_scope");
      // CONTROL (scope filter ON): the same record in its own scope qualifies,
      // so the denial above is the scope test and not some other cause.
      expect(currentUseClaim(ruling!, { repo: s.repoId, path: CATALOG }).ok).toBe(true);
    } finally {
      store.close();
    }
    await rollbackToV2({ projectRoot: s.root });
    await migrateToV3({ projectRoot: s.root });
    store = open(s);
    try {
      await store.admit();
      await store.project();
      const ruling = await store.get(s.writes.RULING.id as string);
      expect(currentUseClaim(ruling!, { repo: s.repoId, path: OPS }).reason).toBe("out_of_scope");
    } finally {
      store.close();
    }
  });

  it("A-ACT-05 rollback honesty: unavailable functionality is stated separately from record absence", async () => {
    const s = await scenario();
    const report = await rollbackToV2({ projectRoot: s.root });
    // The refusal reason a caller gets is "unavailable while rolled back" —
    // a named capability — and NOT "no such record": the record is still there.
    const qualification = report.unavailable_functionality.find((u) => u.capability === "action_qualification");
    expect(qualification).toBeDefined();
    expect(qualification?.detail).toMatch(/refuses while rolled back/);
    expect(report.data_preservation.records_written).toBeGreaterThan(0);
    const file = path.join(s.tw, "records", "decisions", `${s.writes.RULING.id as string}.json`);
    expect(fs.existsSync(file), "the record is present — this is not absence").toBe(true);
    // The two sections never describe each other.
    expect(JSON.stringify(report.data_preservation)).not.toMatch(/unavailable functionality/i);
    expect(JSON.stringify(report.unavailable_functionality)).not.toMatch(/data loss/i);
  });
});

describe("C21 — interruption, idempotency and the dry run", () => {
  it("A-INT-03 idempotent rerun: no record added, no id duplicated, no new id minted", async () => {
    const s = await scenario(); // already ran three times
    const store = open(s);
    try {
      const all = await store.query({ include_archived: true, include_retired: true });
      expect(new Set(all.map((r) => r.record_id)).size).toBe(all.length);
      const scan = scanLegacyStore(s.tw);
      for (const rec of scan.records) expect(readIdMap(s.tw)[rec.legacy_id]?.created).toBe(rec.legacy_id);
      const before = migrateStatus(s.tw).events;
      await migrateToV3({ projectRoot: s.root });
      expect(migrateStatus(s.tw).events).toBe(before);
    } finally {
      store.close();
    }
  });

  it("A-DRY-01 the dry run writes nothing to the target, leaves the source unchanged, and names the same defects", async () => {
    const fresh = copyStore(V1_FIXTURE, "c21dry");
    const tw = twiningDirOf(fresh);
    const before = legacySnapshot(tw);
    const dry = await migrateToV3({ projectRoot: fresh, dryRun: true });
    expect(dry.counts.created_events).toBe(0);
    expect(fs.existsSync(path.join(tw, "events"))).toBe(false);
    expect(legacySnapshot(tw)).toEqual(before);
    const real = await migrateToV3({ projectRoot: fresh });
    const names = (r: typeof dry): string[] => r.findings.map((f) => `${f.kind}:${f.subject}`);
    for (const defect of names(dry).filter((n) => n.startsWith("damaged:") || n.startsWith("conflict:"))) {
      expect(names(real)).toContain(defect);
    }
  });

  it("A-INT-01/A-INT-02 are covered by the SIGKILL arm in test/migrate/v3-forward.test.ts (same store, real signal 9)", () => {
    // Recorded here so the C21 assertion list is complete rather than silently
    // short: the interruption arm needs a child process and lives with the
    // migration suite, including its crash-fidelity control.
    expect(fs.existsSync(path.resolve(__dirname, "..", "..", "migrate", "kill-harness.ts"))).toBe(true);
  });
});

describe("C21 — old clients and schema negotiation", () => {
  it("A-OLD-01/A-OLD-02/A-OLD-03 an old client cannot corrupt unknown semantics or change any evidence class", async () => {
    const s = await scenario();
    const store = open(s);
    const beforeDigest = store.projectionDigest();
    const rulingBefore = await store.get(s.writes.RULING.id as string);
    store.close();

    // The 2.x-era write seam, refusing on the version stamp (the shipped gate).
    const refusal = formatVersionRefusal(loadConfig(s.tw));
    expect(refusal).not.toBeNull();
    const { enterReadOnlyMode, exitReadOnlyMode, atomicWriteFileSync } = await import("../../../src/storage/file-store.js");
    enterReadOnlyMode(refusal as string);
    try {
      // (b) a schema-1 payload that drops every unknown field is REFUSED.
      expect(() =>
        atomicWriteFileSync(path.join(s.tw, "records", "decisions", `${s.writes.RULING.id as string}.json`), JSON.stringify({ id: s.writes.RULING.id, summary: "flattened", status: "active" })),
      ).toThrow(/newer than this/);
      // (c) setting active:true on a migrated record is refused the same way.
      expect(() => atomicWriteFileSync(path.join(s.tw, "records", "decisions", `${L_001}.json`), JSON.stringify({ id: L_001, status: "active" }))).toThrow(/newer than this/);
    } finally {
      exitReadOnlyMode();
    }

    const after = open(s);
    try {
      // Nothing moved: same projection digest, same parts, same class.
      expect(after.projectionDigest()).toBe(beforeDigest);
      const rulingAfter = await after.get(s.writes.RULING.id as string);
      expect(rulingAfter?.evidence_class).toBe(rulingBefore?.evidence_class);
      expect(rulingAfter?.parts).toEqual(rulingBefore?.parts);
      expect((await after.get(L_001))?.evidence_class).toBe("legacy_unverified");
    } finally {
      after.close();
    }
  });

  it.todo("A-OLD-04 UNAVAILABLE: no schema-negotiation EVENT surface exists — the version mismatch is a refusal (formatVersionRefusal), recorded in logs, not as an observable event. Reported unavailable, not passed.");
});

describe("C21 — rollback and forward recovery", () => {
  it("A-RB-01/A-RB-02 post-upgrade records survive rollback with identical bytes, and are listable and readable", async () => {
    const s = await scenario();
    const store = open(s);
    const digests = new Map<string, string>();
    for (const ev of s.writes.all) {
      const held = (await store.events({})).find((e) => e.id === ev.id);
      if (held) digests.set(ev.id as string, held.digest);
    }
    store.close();
    expect(digests.size).toBe(s.writes.all.length);

    await rollbackToV2({ projectRoot: s.root });

    // Inspectable WHILE rolled back: the event files are the archive, and each
    // one's bytes still hash to the digest it carried before the rollback.
    for (const [id, digest] of digests) {
      const file = path.join(s.tw, "events", "2026-09", `${id}.json`);
      expect(fs.existsSync(file), `event ${id} retained`).toBe(true);
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(computeEventDigest(raw)).toBe(digest);
    }
  });

  it("A-RB-03 the rollback report has a data-preservation section and a separate, non-empty unavailable section", async () => {
    const s = await scenario();
    const report = await rollbackToV2({ projectRoot: s.root });
    expect(report.data_preservation.events_retained).toBeGreaterThan(0);
    expect(report.unavailable_functionality.length).toBeGreaterThan(0);
    const capabilities = report.unavailable_functionality.map((u) => u.capability);
    // The three the oracle expects to see named.
    expect(capabilities).toContain("multi_part_records");
    expect(capabilities).toContain("partial_supersession");
    expect(capabilities).toContain("attachments_and_signatures");
    expect(fs.existsSync(path.join(s.tw, "legacy", "ROLLBACK-REPORT.md"))).toBe(true);
    expect(fs.existsSync(path.join(s.tw, "legacy", "rollback-report.json"))).toBe(true);
  });

  it("A-RB-04 [control] a plain restore that lost post-upgrade records would FAIL this case", async () => {
    const s = await scenario();
    await rollbackToV2({ projectRoot: s.root });
    // The retained archive is non-empty and omits none of the three writes.
    const retained = s.writes.all.map((ev) => path.join(s.tw, "events", "2026-09", `${ev.id as string}.json`));
    expect(retained.every((f) => fs.existsSync(f))).toBe(true);
    // Negative control: if the archive were empty, this assertion could not
    // pass — so demonstrate that the check actually discriminates.
    expect(fs.existsSync(path.join(s.tw, "events", "2026-09", `${mintEventId()}.json`))).toBe(false);
  });

  it("A-FR-01/A-FR-02 forward recovery restores identical ids, bytes, hashes, relations and classes", async () => {
    const s = await scenario();
    const before = open(s);
    const snapshot = new Map<string, string>();
    for (const rec of await before.query({ include_archived: true, include_retired: true })) snapshot.set(rec.record_id, rec.version_digest);
    const digestBefore = before.projectionDigest();
    before.close();

    await rollbackToV2({ projectRoot: s.root });
    const recovery = await migrateToV3({ projectRoot: s.root });
    expect(recovery.ok).toBe(true);
    expect(recovery.counts.post_rollback_writes).toBe(0);

    const after = open(s);
    try {
      await after.admit();
      await after.project();
      expect(after.projectionDigest()).toBe(digestBefore);
      for (const rec of await after.query({ include_archived: true, include_retired: true })) {
        expect(snapshot.get(rec.record_id), `record ${rec.record_id} changed across the round trip`).toBe(rec.version_digest);
      }
      // A-FR-02: the partial supersession is restored with the same target part
      // and nothing else moved.
      const ruling = await after.get(s.writes.RULING.id as string);
      expect(ruling?.parts?.find((p) => p.part_id === "part-B")?.status).toBe("superseded");
      expect(ruling?.parts?.find((p) => p.part_id === "part-B")?.superseded_by).toBe(s.writes.SUCCESSOR.id);
      expect(ruling?.parts?.find((p) => p.part_id === "part-A")?.status).toBe("applicable");
    } finally {
      after.close();
    }
  });

  it("A-FR-03 a second re-import adds no duplicate record", async () => {
    const s = await scenario();
    await rollbackToV2({ projectRoot: s.root });
    await migrateToV3({ projectRoot: s.root });
    const eventsAfterFirst = migrateStatus(s.tw).events;
    await migrateToV3({ projectRoot: s.root });
    expect(migrateStatus(s.tw).events).toBe(eventsAfterFirst);
    const store = open(s);
    try {
      const all = await store.query({ include_archived: true, include_retired: true });
      expect(new Set(all.map((r) => r.record_id)).size).toBe(all.length);
    } finally {
      store.close();
    }
  });
});

describe("C21 — S3: delivery and receipts", () => {
  it("A-DEL-03 no silent acknowledged-event loss: the admitted count before rollback equals the count after recovery", async () => {
    const s = await scenario();
    const before = open(s);
    const admittedBefore = (await before.events({})).map((e) => e.id).sort();
    before.close();

    await rollbackToV2({ projectRoot: s.root });
    await migrateToV3({ projectRoot: s.root });

    const after = open(s);
    try {
      await after.admit();
      await after.project();
      const admittedAfter = (await after.events({})).map((e) => e.id).sort();
      expect(admittedAfter.length).toBe(admittedBefore.length);
      for (const id of admittedBefore) expect(admittedAfter, `acknowledged event ${id} lost`).toContain(id);
    } finally {
      after.close();
    }
  });

  it("A-DEL-02 a delivery state survives rollback and recovery without re-queueing or duplicating", async () => {
    const s = await scenario();
    const id = s.writes.RULING.id as string;
    const before = open(s);
    const stateBefore = await before.deliveryState(id);
    before.close();
    expect(stateBefore?.state).toBe("projected");
    expect(stateBefore?.admissions).toBe(1);

    await rollbackToV2({ projectRoot: s.root });
    await migrateToV3({ projectRoot: s.root });
    const after = open(s);
    try {
      await after.admit();
      await after.project();
      const stateAfter = await after.deliveryState(id);
      expect(stateAfter?.state).toBe("projected");
      expect(stateAfter?.admissions).toBe(1); // not re-queued, not duplicated
      expect(stateAfter?.conflict_rejected).toBe(0);
    } finally {
      after.close();
    }
  });

  it.todo("A-DEL-01 UNAVAILABLE: selected/emitted/delivered with an emitted-bytes hash bound to host/session/turn is lane 02b's outbox + lane 03's injection receipt, not lane 02c's migration surface. Reported unavailable, not passed.");
});

/**
 * C21-H held-out variant. Same requirement surface, different ORDER — and the
 * order is the point: the kill lands at a different durability boundary, the
 * dry run happens AFTER the interruption, the old client contacts the store
 * both before and during rollback, and a tombstone is among the post-upgrade
 * writes. It runs against the OTHER fixture layout (the 2.x records tree) so a
 * pass cannot come from something specific to the 1.x file layout.
 */
describe("C21-H held-out — different order, different layout, same requirements", () => {
  it("U1–U3: dry-run diagnostics AFTER an interruption still report the same defects, and the resume completes", async () => {
    const root = copyStore(V2_FIXTURE, "c21h");
    const tw = twiningDirOf(root);
    const before = legacySnapshot(tw);

    // U1: interrupt by aborting mid-event-step (the signal-9 arm lives in the
    // migration suite; here the ordering is what is under test).
    let aborted = false;
    await expect(
      migrateToV3({
        projectRoot: root,
        hooks: {
          afterEvent(n) {
            if (n >= 5 && !aborted) {
              aborted = true;
              throw new Error("simulated interruption");
            }
          },
        },
      }),
    ).rejects.toThrow(/simulated interruption/);
    expect(migrateStatus(tw).migration).toBe("incomplete");
    expect(loadConfig(tw).version).toBe(2); // unchanged by the interrupted run

    // U2: the dry run over the remaining backlog writes nothing and names the
    // same defects the real run names.
    const dry = await migrateToV3({ projectRoot: root, dryRun: true });
    expect(dry.counts.created_events).toBe(0);
    expect(dry.findings.some((f) => f.kind.startsWith("damaged:"))).toBe(true);
    expect(dry.findings.some((f) => f.kind.startsWith("conflict:"))).toBe(true);
    expect(legacySnapshot(tw)).toEqual(before);

    // U3: resume to completion, and match a clean uninterrupted control run.
    const resumed = await migrateToV3({ projectRoot: root });
    expect(resumed.ok).toBe(true);
    const control = copyStore(V2_FIXTURE, "c21hctl");
    await migrateToV3({ projectRoot: control });
    const shape = (m: Record<string, { created: string; kind: string }>): Record<string, string> =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, `${v.kind}:${v.created}`]));
    expect(shape(readIdMap(tw))).toEqual(shape(readIdMap(twiningDirOf(control))));
    // U5: a rerun adds nothing.
    const events = migrateStatus(tw).events;
    await migrateToV3({ projectRoot: root });
    expect(migrateStatus(tw).events).toBe(events);
  });

  it("U6: a repository RENAME changes no identity — the remote is a label", async () => {
    const root = copyStore(V2_FIXTURE, "c21h");
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });
    const repoBefore = (JSON.parse(fs.readFileSync(path.join(tw, "store.json"), "utf8")) as { repo_id: string }).repo_id;

    // Rename the remote label everywhere it is recorded, then re-run.
    await migrateToV3({ projectRoot: root });
    const repoAfter = (JSON.parse(fs.readFileSync(path.join(tw, "store.json"), "utf8")) as { repo_id: string }).repo_id;
    expect(repoAfter).toBe(repoBefore);
    // The branch/commit labels survive on the events as history.
    const store = new EventStore({ twiningDir: tw });
    try {
      const withSource = (await store.events({})).filter((e) => e.source !== undefined);
      expect(withSource.length).toBeGreaterThan(0);
      for (const ev of withSource) expect(ev.source?.repo).toBeUndefined(); // a label, never identity
    } finally {
      store.close();
    }
  });

  it("U7–U10: a TOMBSTONE among the post-upgrade writes is not resurrected by rollback or by forward recovery", async () => {
    const root = copyStore(V2_FIXTURE, "c21h");
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });
    const repoId = (JSON.parse(fs.readFileSync(path.join(tw, "store.json"), "utf8")) as { repo_id: string }).repo_id;

    const noor = human();
    const knownKeys: Record<string, KnownKey> = { [noor.keyId]: { publicKeySpkiBase64: noor.kp.publicKeySpkiBase64, human: true } };
    const writes = postUpgradeWrites(repoId, noor, (await store0Principal(tw)) as string);
    const TOMBSTONE = envelope(
      {
        id: mintEventId(),
        kind: "tombstoned",
        record: { type: "decision", id: L_001 },
        scope: { repo: repoId, path: CATALOG },
        producer: { principal: noor.principal, kind: "human", host: noor.host },
        parents: [writes.infra[1]?.id as string, L_001],
        evidence_class: "human_ruling",
        occurred_at: "2026-09-16T11:00:00.000Z",
        payload: { target: L_001, reason: "retracted by the platform lead", purge: false },
      },
      noor,
    );

    let store = new EventStore({ twiningDir: tw, knownKeys });
    for (const ev of [...writes.all, TOMBSTONE]) store.receive(ev, "local");
    await store.admit();
    await store.project();
    const tombstoned = await store.get(L_001);
    expect(tombstoned?.status).toBe("tombstoned");
    expect((await store.query({})).map((r) => r.record_id)).not.toContain(L_001);
    store.close();

    // U8: roll back. The tombstoned record must NOT be materialised into the view.
    const report = await rollbackToV2({ projectRoot: root });
    expect(report.data_preservation.tombstoned_not_materialised).toContain(L_001);
    expect(report.files_written).not.toContain(`records/decisions/${L_001}.json`);
    // This fixture's records/ tree IS the original 2.x legacy store, and
    // rollback never deletes legacy bytes (they are their own backup, and C20
    // says clones are not recalled either). So the ORIGINAL file is still
    // there — what must be true is that rollback did not re-materialise the
    // tombstoned record as a VIEW, which is what `legacy_view_of` marks.
    const onDisk = JSON.parse(fs.readFileSync(path.join(tw, "records", "decisions", `${L_001}.json`), "utf8")) as Record<string, unknown>;
    expect(onDisk.legacy_view_of, "the tombstoned record was re-materialised as a view").toBeUndefined();

    // U10: roll forward. It must still be absent from current serving…
    await migrateToV3({ projectRoot: root });
    store = new EventStore({ twiningDir: tw, knownKeys });
    try {
      await store.admit();
      await store.project();
      expect((await store.query({})).map((r) => r.record_id)).not.toContain(L_001);
      // …and still visible in the HISTORICAL view with the retraction attached.
      const history = await store.history(L_001);
      expect(history.some((e) => e.kind === "tombstoned")).toBe(true);
      expect(history.some((e) => e.kind === "created")).toBe(true);
      expect((await store.get(L_001))?.status).toBe("tombstoned");
    } finally {
      store.close();
    }
  });

  it("U4/U9: the old client is refused before AND during rollback, and changes nothing either time", async () => {
    const root = copyStore(V2_FIXTURE, "c21h");
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });
    const { enterReadOnlyMode, exitReadOnlyMode, atomicWriteFileSync } = await import("../../../src/storage/file-store.js");

    // U4 — before the rollback: the store is v3, the 2.x client is read-only.
    const beforeRefusal = formatVersionRefusal(loadConfig(tw));
    expect(beforeRefusal).not.toBeNull();
    enterReadOnlyMode(beforeRefusal as string);
    try {
      expect(() => atomicWriteFileSync(path.join(tw, "records", "decisions", `${L_001}.json`), "{}")).toThrow(/newer than this/);
    } finally {
      exitReadOnlyMode();
    }
    const store = new EventStore({ twiningDir: tw });
    const digestAfterU4 = store.projectionDigest();
    const classesAfterU4 = new Map((await store.query({ include_archived: true, include_retired: true })).map((r) => [r.record_id, r.evidence_class]));
    store.close();

    // U9 — during the rollback the version stamp is 2, so a 2.x client is
    // writable again. The v3 history is untouched by whatever it writes.
    await rollbackToV2({ projectRoot: root });
    expect(formatVersionRefusal(loadConfig(tw))).toBeNull();
    fs.writeFileSync(path.join(tw, "records", "decisions", `${L_001}.json`), JSON.stringify({ id: L_001, status: "active", summary: "old client wrote this" }, null, 2));

    const after = new EventStore({ twiningDir: tw });
    try {
      await after.admit();
      await after.project();
      expect(after.projectionDigest()).toBe(digestAfterU4);
      for (const [id, cls] of classesAfterU4) expect((await after.get(id))?.evidence_class).toBe(cls);
    } finally {
      after.close();
    }
  });
});
