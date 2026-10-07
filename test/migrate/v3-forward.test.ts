/**
 * `twining migrate --to 3` — ADR §10.1–§10.6, §10.9.
 *
 * Every assertion reads the STORE, never the migration's own return value,
 * except where the return value is itself the surface under test (the report).
 * The fixtures are committed bytes, so a manifest hash mismatch is a real
 * regression rather than a re-derived tautology.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  migrateToV3,
  migrateStatus,
  readIdMap,
  readManifest,
  readMigrationState,
  derivedId,
  scopeFromLegacy,
  type LegacyManifest,
} from "../../src/migrate/v3-forward.js";
import { scanLegacyStore } from "../../src/migrate/legacy-scan.js";
import { EventStore } from "../../src/events/event-store.js";
import { eventEnvelopeSchema } from "../../src/contracts/event.js";
import { computeEventDigest } from "../../src/contracts/canonical.js";
import { SUPPORTED_CONFIG_VERSION, formatVersionRefusal, loadConfig } from "../../src/config.js";
import { cleanupStores, copyStore, legacySnapshot, readJson, twiningDirOf, V1_FIXTURE, V2_FIXTURE } from "./v3-helpers.js";

afterAll(cleanupStores);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

// Review-regression fixture ids (test/fixtures/legacy-stores/generate.ts).
const NON_UTF8_ID = "01M3C21DBYTES0000000000000";
const ARCHIVED_FROM_PROVISIONAL_ID = "01M3C21DARCPV0000000000000";
const OVERRIDDEN_BY_ACTOR_ID = "01M3C21DVRDAC0000000000000";

describe("migrate --to 3: manifest and dry run (§10.1)", () => {
  it("the dry run writes the manifest and NOTHING else, and leaves the legacy bytes untouched", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    const before = legacySnapshot(tw);
    const configBefore = fs.readFileSync(path.join(tw, "config.yml"), "utf8");

    const report = await migrateToV3({ projectRoot: root, dryRun: true });

    expect(report.ok).toBe(true);
    expect(report.dry_run).toBe(true);
    expect(fs.existsSync(path.join(tw, "legacy", "manifest.json"))).toBe(true);
    // Nothing of the target store exists yet.
    expect(fs.existsSync(path.join(tw, "events"))).toBe(false);
    expect(fs.existsSync(path.join(tw, "attachments"))).toBe(false);
    expect(fs.existsSync(path.join(tw, "store.json"))).toBe(false);
    expect(fs.readFileSync(path.join(tw, "config.yml"), "utf8")).toBe(configBefore);
    expect(legacySnapshot(tw)).toEqual(before);
    expect(migrateStatus(tw).migration).toBe("not_started");
  });

  it("the manifest carries sha256 + length of every legacy file, every id and every relationship field", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root, dryRun: true });
    const manifest = readJson<LegacyManifest>(path.join(tw, "legacy", "manifest.json"));

    // Files: hashed from disk, compared against an independent hash here.
    expect(Object.keys(manifest.files)).toContain("blackboard.jsonl");
    expect(Object.keys(manifest.files)).toContain("decisions/index.json");
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const bytes = fs.readFileSync(path.join(tw, rel));
      expect(entry.sha256).toBe(sha(bytes));
      expect(entry.bytes).toBe(bytes.length);
    }

    // Ids: every recoverable record, keyed by id@file so a duplicate-declared
    // id keeps BOTH rows instead of one overwriting the other.
    const ids = Object.keys(manifest.ids);
    expect(ids.some((k) => k.startsWith("01M3C21DACT1V0000000000000@"))).toBe(true);
    expect(ids.filter((k) => k.startsWith("01M3C21DDPCT10000000000000@"))).toHaveLength(2);

    // Relationship fields, verbatim.
    expect(manifest.relationships["01M3C21DSPSW10000000000000"]?.superseded_by).toBe("01M3C21DACT1V0000000000000");
    expect(manifest.relationships["01M3C21DACT1V0000000000000"]?.supersedes).toBe("01M3C21DSPSN10000000000000");
    expect(manifest.relationships["01M3C21DVRDW10000000000000"]?.overridden_by).toBe("01M3C21DACT1V0000000000000");
    expect(manifest.relationships["01M3C21DARCW10000000000000"]?.archived_from).toBe("active");
    expect(manifest.relationships["01M3C21PRETS10000000000000"]?.relates_to).toEqual(["01M3C21P0PENW0000000000000"]);
    expect(manifest.relationships["01M3C21RAFFC10000000000000"]?.source).toBe("01M3C21EFMAP10000000000000");
  });

  it("the dry run reports the SAME findings the real run reports (conflict and truncation named in both)", async () => {
    const dry = await migrateToV3({ projectRoot: copyStore(V1_FIXTURE), dryRun: true });
    const real = await migrateToV3({ projectRoot: copyStore(V1_FIXTURE) });
    const kinds = (r: typeof dry): string[] => r.findings.map((f) => `${f.kind}:${f.subject}`).sort();

    expect(kinds(dry)).toContain("damaged:unparseable:decisions/01M3C21DBAD010000000000000.json");
    expect(kinds(dry)).toContain("damaged:conflict_markers:decisions/01M3C21DCNFM10000000000000.json");
    expect(kinds(dry)).toContain("conflict:duplicate_declared_id:01M3C21DDPCT10000000000000");
    // The real run's findings are a superset only by rejections (there are none here).
    for (const k of kinds(dry)) expect(kinds(real)).toContain(k);
  });
});

describe("migrate --to 3: events (§10.2)", () => {
  let root: string;
  let tw: string;
  let store: EventStore;

  beforeAll(async () => {
    root = copyStore(V1_FIXTURE);
    tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });
    store = new EventStore({ twiningDir: tw });
    await store.admit();
    await store.project();
  });

  afterAll(() => store.close());

  it("every legacy record becomes one `created` event whose id IS the legacy id (§10.3)", async () => {
    const scan = scanLegacyStore(tw);
    for (const rec of scan.records) {
      const rec3 = await store.get(rec.legacy_id);
      expect(rec3, `record ${rec.legacy_id} is missing`).not.toBeNull();
      const created = (await store.history(rec.legacy_id)).find((e) => e.kind === "created" && e.id === rec.legacy_id);
      expect(created, `created event for ${rec.legacy_id}`).toBeDefined();
      expect(created?.record?.id).toBe(rec.legacy_id);
    }
  });

  it("the created payload is the record MINUS its lifecycle fields", async () => {
    const [created] = await store.history("01M3C21DSPSW10000000000000");
    const payload = created?.payload as Record<string, unknown>;
    expect(payload.summary).toBe("catalog output stays on publication hold");
    // Lifecycle and identity fields moved to events; they are not body.
    for (const field of ["id", "timestamp", "agent_id", "scope", "status", "superseded_by", "provenance"]) {
      expect(payload, `payload still carries ${field}`).not.toHaveProperty(field);
    }
  });

  it("the attachment is the EXACT legacy bytes with source_kind legacy_record, stored content-addressed", async () => {
    const scan = scanLegacyStore(tw);
    for (const rec of scan.records) {
      const created = (await store.history(rec.legacy_id)).find((e) => e.kind === "created");
      const att = created?.attachments?.[0];
      expect(att?.source_kind).toBe("legacy_record");
      expect(att?.sha256).toBe(rec.sha256);
      expect(att?.bytes).toBe(rec.raw.length);
      const file = path.join(tw, "attachments", rec.sha256.slice(0, 2), rec.sha256);
      expect(fs.existsSync(file), `attachment for ${rec.legacy_id}`).toBe(true);
      // The STORED bytes hash to the manifest value — not a re-derived one.
      expect(sha(fs.readFileSync(file))).toBe(rec.sha256);
      expect(fs.readFileSync(file).toString("utf8")).toBe(rec.raw.toString("utf8"));
    }
  });

  it("every migrated event is legacy_unverified, flagged derived_from_legacy_snapshot, and never human_ruling", async () => {
    const events = await store.events({});
    expect(events.length).toBeGreaterThan(20);
    for (const ev of events) {
      expect(ev.evidence_class).toBe("legacy_unverified");
      expect(ev.legacy?.derived_from_legacy_snapshot).toBe(true);
    }
    // A legacy `active` decision with a promoted_by never acquires authority.
    const active = await store.get("01M3C21DACT1V0000000000000");
    expect(active?.evidence_class).toBe("legacy_unverified");
    expect(active?.authorizes_action).toBe(false);
  });

  it("asserted_actor carries the legacy agent_id, and `source` comes from legacy provenance", async () => {
    const [created] = await store.history("01M3C21DACT1V0000000000000");
    expect(created?.producer.asserted_actor).toBe("agent-scribe");
    expect(created?.source?.branch).toBe("main");
    expect(created?.source?.commit).toBe("a".repeat(40));
    // The producer PRINCIPAL is the migrator's, never the legacy label.
    expect(created?.producer.principal).toMatch(/^p_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created?.producer.principal).not.toBe("agent-scribe");
  });

  it("derived lifecycle events reconstruct each status field", async () => {
    const kindsFor = async (id: string): Promise<string[]> => (await store.history(id)).map((e) => e.kind).sort();

    expect(await kindsFor("01M3C21DACT1V0000000000000")).toContain("promoted"); // promoted_by/at
    expect(await kindsFor("01M3C21DSPSW10000000000000")).toContain("superseded"); // superseded_by
    expect(await kindsFor("01M3C21DVRDW10000000000000")).toContain("overridden"); // overridden_by
    expect(await kindsFor("01M3C21DARCW10000000000000")).toContain("archived"); // archived_from
    expect(await kindsFor("01M3C21DAMND10000000000000")).toContain("amended"); // amendments[]
    expect(await kindsFor("01M3C21PRES0V0000000000000")).toContain("resolved"); // post resolved
    expect(await kindsFor("01M3C21HACK010000000000000")).toContain("acknowledged"); // handoff acknowledged

    const amendments = (await store.history("01M3C21DAMND10000000000000")).filter((e) => e.kind === "amended");
    expect(amendments).toHaveLength(2);
    const amended = await store.get("01M3C21DAMND10000000000000");
    expect(amended?.body.affected_files).toContain("src/billing/invoice.ts");
    expect(amended?.body.affected_symbols).toContain("renderInvoice");
  });

  it("archival is a FLAG beside an untouched status, and a provisional stays provisional (§4.4)", async () => {
    const archived = await store.get("01M3C21DARCW10000000000000");
    expect(archived?.archived).toBe(true);
    expect(archived?.archived_from).toBe("active");
    expect(archived?.status).toBe("active"); // archived is not a status replacement
    expect(archived?.revoked).toBe(false);

    const provisional = await store.get("01M3C21DPR0V10000000000000");
    expect(provisional?.status).toBe("provisional");
    expect((await store.history("01M3C21DPR0V10000000000000")).some((e) => e.kind === "promoted")).toBe(false);
  });

  it("a missing superseded_by is salvaged from the other record's `supersedes` pointer, and flagged", async () => {
    const salvaged = await store.get("01M3C21DSPSN10000000000000");
    expect(salvaged?.status).toBe("superseded");
    expect(salvaged?.superseded_by).toEqual(["01M3C21DACT1V0000000000000"]);
    const ev = (await store.history("01M3C21DSPSN10000000000000")).find((e) => e.kind === "superseded");
    expect(ev?.legacy?.legacy_ambiguity).toContain("superseded_by_recovered_from_supersedes_pointer");
  });

  it("ambiguity with NO recoverable answer is preserved, never resolved (§10.2)", async () => {
    // Superseded with no pointer in either direction.
    const orphan = (await store.history("01M3C21DSPS0R0000000000000")).find((e) => e.kind === "overridden");
    expect(orphan?.legacy?.legacy_ambiguity).toContain("superseded_without_superseded_by");
    expect(orphan?.legacy?.legacy_status).toBe("superseded"); // the original word survives
    expect((await store.get("01M3C21DSPS0R0000000000000"))?.applicable).toBe(false);

    // Overridden with no overridden_by — the ADR's own example.
    const noOverrider = (await store.history("01M3C21DVRDN10000000000000")).find((e) => e.kind === "overridden");
    expect(noOverrider?.legacy?.legacy_ambiguity).toContain("overridden_without_overridden_by");
    expect((await store.get("01M3C21DVRDN10000000000000"))?.overridden_by).toBeUndefined();

    // Archived with no archived_from.
    const noFrom = (await store.history("01M3C21DARCN10000000000000")).find((e) => e.kind === "archived");
    expect(noFrom?.legacy?.legacy_ambiguity).toContain("archived_without_archived_from");

    // A record whose id disagrees with its filename keeps BOTH facts.
    const mismatch = await store.get("01M3C21DMSMT10000000000000");
    expect(mismatch?.legacy?.legacy_ambiguity?.some((a) => a.startsWith("id_filename_mismatch:"))).toBe(true);
  });

  it("a damaged file is quarantined with its recoverable bytes and never reconstructed", async () => {
    const manifest = readManifest(tw) as LegacyManifest;
    expect(manifest.damaged.map((d) => d.reason).sort()).toEqual(["conflict_markers", "unparseable"]);
    for (const d of manifest.damaged) {
      const kept = path.join(tw, "legacy", "quarantine", `${d.sha256}.bytes`);
      expect(fs.existsSync(kept)).toBe(true);
      expect(sha(fs.readFileSync(kept))).toBe(d.sha256);
      // No record was invented for it.
      expect(await store.get(d.file)).toBeNull();
    }
    // The truncated body's prefix survives verbatim; nothing was completed.
    const truncated = manifest.damaged.find((d) => d.reason === "unparseable");
    expect(truncated?.recoverable_prefix).toContain("truncated mid-pay");
    expect(truncated?.recoverable_prefix.endsWith("}")).toBe(false);
  });

  it("two files declaring one id keep BOTH byte streams, flag the pair, and admit neither as the value", async () => {
    const primary = await store.get("01M3C21DDPCT10000000000000");
    expect(primary).not.toBeNull();
    const contested = primary?.contested ?? [];
    expect(contested.length).toBeGreaterThan(0);
    const rivalId = contested[0]?.claimant as string;
    const rival = await store.get(rivalId);
    expect(rival).not.toBeNull();
    expect(rival?.body.summary).not.toBe(primary?.body.summary); // different bytes, both kept
    expect(rival?.legacy?.legacy_ambiguity).toContain("duplicate_declared_id:01M3C21DDPCT10000000000000");
    // Neither is served as the resolved value: the rival is not in default
    // retrieval at all, and the primary carries the conflict annotation.
    const current = (await store.query({})).map((r) => r.record_id);
    expect(current).not.toContain(rivalId);
    expect(rival?.archived).toBe(true);
    expect(rival?.revoked).toBe(false); // retained for inspection, NOT revoked
    expect((await store.query({ include_archived: true })).map((r) => r.record_id)).toContain(rivalId);
  });

  it("a post entry_type the v3 enum cannot hold is flagged, and the original survives verbatim", async () => {
    const post = await store.get("01M3C21PKYND10000000000000");
    expect(post?.legacy?.legacy_ambiguity).toContain("entry_type_not_representable:decision");
    expect(post?.body.legacy_entry_type).toBe("decision");
    // …and the untouched bytes are in the attachment either way.
    const created = (await store.history("01M3C21PKYND10000000000000")).find((e) => e.kind === "created");
    const att = created?.attachments?.[0] as { sha256: string };
    const bytes = fs.readFileSync(path.join(tw, "attachments", att.sha256.slice(0, 2), att.sha256), "utf8");
    expect(JSON.parse(bytes).entry_type).toBe("decision");
  });

  it("a decision on disk but absent from decisions/index.json is still migrated (index desync)", async () => {
    expect(await store.get("01M3C21DRPHN10000000000000")).not.toBeNull();
  });

  it("legacy files are never modified", () => {
    const fresh = copyStore(V1_FIXTURE);
    const before = legacySnapshot(twiningDirOf(fresh));
    return migrateToV3({ projectRoot: fresh }).then(() => {
      expect(legacySnapshot(twiningDirOf(fresh))).toEqual(before);
    });
  });
});

describe("migrate --to 3: id map (§10.3)", () => {
  it("is total over migrated records, injective, and round-trips both ways", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });
    const idMap = readIdMap(tw);
    const scan = scanLegacyStore(tw);

    for (const rec of scan.records) {
      expect(idMap[rec.legacy_id], `id-map entry for ${rec.legacy_id}`).toBeDefined();
      expect(idMap[rec.legacy_id]?.created).toBe(rec.legacy_id); // identity (§10.3)
    }
    const createdIds = Object.values(idMap).map((e) => e.created);
    expect(new Set(createdIds).size).toBe(createdIds.length); // injective
    // Reverse: every created event id resolves back to exactly one entry.
    for (const [legacy, entry] of Object.entries(idMap)) {
      const back = Object.entries(idMap).filter(([, e]) => e.created === entry.created);
      expect(back).toHaveLength(1);
      expect(back[0]?.[0]).toBe(legacy);
    }
    // Derived event ids are recorded too.
    expect(idMap["01M3C21DACT1V0000000000000"]?.derived.some((d) => d.kind === "promoted")).toBe(true);
  });

  it("is IDENTICAL across a rerun and a clean control run on the same fixture", async () => {
    const a = copyStore(V1_FIXTURE);
    const b = copyStore(V1_FIXTURE);
    await migrateToV3({ projectRoot: a });
    await migrateToV3({ projectRoot: a }); // rerun
    await migrateToV3({ projectRoot: b }); // clean control
    // The migrator's own identity is seeded from the store path, so compare
    // the RECORD mapping (which must not depend on where the store lives).
    const strip = (m: Record<string, { created: string; kind: string }>): Record<string, string> =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, `${v.kind}:${v.created}`]));
    expect(strip(readIdMap(twiningDirOf(a)))).toEqual(strip(readIdMap(twiningDirOf(b))));
  });
});

describe("migrate --to 3: verify and finalize (§10.4, §10.5)", () => {
  it("finalize stamps store.json, config.version 3 and RECORDS-FROZEN.md, and verification passes", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    const report = await migrateToV3({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.verification?.ok).toBe(true);
    expect(report.verification?.missing).toEqual([]);
    expect(report.verification?.status_mismatched).toEqual([]);
    expect(report.verification?.relationships_missing).toEqual([]);
    expect(report.verification?.attachment_mismatched).toEqual([]);
    expect(report.verification?.attachments_checked).toBe(report.counts.legacy_records);

    const storeJson = readJson<{ store_id: string; repo_id: string; format: number }>(path.join(tw, "store.json"));
    expect(storeJson.format).toBe(3);
    expect(storeJson.store_id).toMatch(/^s_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(storeJson.repo_id).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(loadConfig(tw).version).toBe(3);
    expect(fs.readFileSync(path.join(tw, "records", "RECORDS-FROZEN.md"), "utf8")).toContain("FROZEN");
    expect(migrateStatus(tw).migration).toBe("complete");
    expect(migrateStatus(tw).remaining_steps).toEqual([]);
  });

  it("a verification failure leaves config.version UNCHANGED", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root, dryRun: true });
    // Break one attachment's future home so the byte check must fail: make the
    // attachments directory a FILE, so no attachment can be written.
    fs.writeFileSync(path.join(tw, "attachments"), "not a directory");
    const report = await migrateToV3({ projectRoot: root });
    expect(report.ok).toBe(false);
    expect(report.verification?.ok).toBe(false);
    expect(report.verification?.attachment_mismatched.length).toBeGreaterThan(0);
    // The I/O failure is REPORTED, not thrown from the middle of the run.
    expect(report.findings.some((f) => f.kind === "attachment:unwritable")).toBe(true);
    expect(loadConfig(tw).version).toBe(1);
    expect(fs.existsSync(path.join(tw, "store.json"))).toBe(false);
    expect(migrateStatus(tw).migration).toBe("incomplete");
  });

  it("both fixture layouts migrate, and the v2 tree needs no twining.db to do it", async () => {
    const root = copyStore(V2_FIXTURE);
    const tw = twiningDirOf(root);
    expect(fs.existsSync(path.join(tw, "twining.db"))).toBe(false);
    const report = await migrateToV3({ projectRoot: root });
    expect(report.ok).toBe(true);
    expect(readManifest(tw)?.layouts).toEqual(["v2"]);
  });
});

describe("migrate --to 3: rerun and interruption (§10.6)", () => {
  it("a rerun adds no record, mints no id, and suppresses every event as a duplicate", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    const first = await migrateToV3({ projectRoot: root });
    const eventsAfterFirst = migrateStatus(tw).events;
    const idMapAfterFirst = readIdMap(tw);

    const second = await migrateToV3({ projectRoot: root });
    const third = await migrateToV3({ projectRoot: root });

    expect(migrateStatus(tw).events).toBe(eventsAfterFirst);
    expect(readIdMap(tw)).toEqual(idMapAfterFirst);
    expect(second.counts.created_events).toBe(first.counts.created_events);
    expect(second.counts.duplicate_suppressed).toBeGreaterThan(0);
    expect(third.counts.duplicate_suppressed).toBe(second.counts.duplicate_suppressed);
    expect(third.ok).toBe(true);

    const store = new EventStore({ twiningDir: tw });
    const all = await store.query({ include_archived: true, include_retired: true });
    expect(new Set(all.map((r) => r.record_id)).size).toBe(all.length); // no duplicate record ids
    store.close();
  });

  it("derived event ids are deterministic, so a resume cannot fork the history", () => {
    const seed = "01M3C21DACT1V0000000000000:promoted:{}";
    expect(derivedId(seed)).toBe(derivedId(seed));
    expect(derivedId(seed)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(derivedId(seed)).not.toBe(derivedId(`${seed} `));
  });

  describe("SIGKILL during the event step (crash fidelity)", () => {
    const ENTRY = path.join(os.tmpdir(), `twining-kill-harness-${process.pid}.mjs`);

    beforeAll(async () => {
      const { build } = await import("esbuild");
      await build({
        entryPoints: [path.resolve(__dirname, "kill-harness.ts")],
        outfile: ENTRY,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        // Everything is INLINED: the bundle runs from a temp directory with no
        // node_modules beside it, so leaving packages external would make the
        // child die on a resolution error and read as a failed migration.
        external: ["node:sqlite"],
        // proper-lockfile is CJS; esbuild's dynamic-require fallback needs a
        // real `require` in scope (same shim as scripts/build-plugin-bundle.mjs).
        banner: {
          js: [
            'import { createRequire as __cr } from "node:module";',
            'if (typeof globalThis.require === "undefined") { globalThis.require = __cr(import.meta.url); }',
          ].join("\n"),
        },
        logLevel: "silent",
      });
    }, 60_000);

    afterAll(() => fs.rmSync(ENTRY, { force: true }));

    it("leaves only COMPLETE events, reads `incomplete`, and resumes to the clean-control result", async () => {
      const killed = copyStore(V1_FIXTURE);
      const tw = twiningDirOf(killed);

      const child = spawnSync(process.execPath, [ENTRY, killed, "6"], { encoding: "utf8", timeout: 120_000 });
      // The crash-fidelity control: the run must have DIED on signal 9. A
      // graceful close would make every assertion below pass for the wrong
      // reason, so the oracle requires this check to be independent.
      expect(child.signal).toBe("SIGKILL");
      expect(child.status).toBeNull();

      // Every event on disk is complete and validates — no half-written record.
      const eventFiles: string[] = [];
      const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(dir, e.name));
          else if (e.name.endsWith(".json")) eventFiles.push(path.join(dir, e.name));
        }
      };
      walk(path.join(tw, "events"));
      expect(eventFiles.length).toBeGreaterThan(0);
      for (const file of eventFiles) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        expect(eventEnvelopeSchema.safeParse(raw).success, `incomplete envelope in ${file}`).toBe(true);
        expect(raw.digest).toBe(computeEventDigest(raw));
      }

      // The state reads INCOMPLETE, never complete, and config is untouched.
      const status = migrateStatus(tw);
      expect(status.migration).toBe("incomplete");
      expect(status.remaining_steps).toContain("finalize");
      expect(status.records_frozen).toBe(false);
      expect(loadConfig(tw).version).toBe(1);
      expect(readMigrationState(tw)?.status).toBe("incomplete");

      // Resume, and compare against a clean uninterrupted control run.
      const resumed = await migrateToV3({ projectRoot: killed });
      expect(resumed.ok).toBe(true);
      const control = copyStore(V1_FIXTURE);
      await migrateToV3({ projectRoot: control });

      const shape = (m: Record<string, { created: string; kind: string }>): Record<string, string> =>
        Object.fromEntries(Object.entries(m).map(([k, v]) => [k, `${v.kind}:${v.created}`]));
      expect(shape(readIdMap(tw))).toEqual(shape(readIdMap(twiningDirOf(control))));
      expect(migrateStatus(tw).events).toBe(migrateStatus(twiningDirOf(control)).events);
    }, 180_000);

    it("CONTROL: a graceful close at the same point does NOT die on a signal", () => {
      const graceful = copyStore(V1_FIXTURE);
      const child = spawnSync(process.execPath, [ENTRY, graceful, "6", "graceful"], { encoding: "utf8", timeout: 120_000 });
      expect(child.signal).toBeNull();
      expect(child.status).toBe(0);
      // Proving the two arms differ is what makes the SIGKILL arm evidence of
      // a durability boundary rather than of ordinary shutdown.
    }, 120_000);
  });
});

describe("migrate --to 3: old clients (§10.9)", () => {
  it("a 2.x-era reader goes READ-ONLY on config.version 3 and never sees events/", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });

    // The shipped 2.x gate, unchanged: this is the existing code path, not a
    // v3-aware one, so it is real evidence about an old client.
    const config = loadConfig(tw);
    expect(config.version).toBe(3);
    expect(config.version).toBeGreaterThan(SUPPORTED_CONFIG_VERSION);
    const refusal = formatVersionRefusal(config);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("newer than this");
    expect(refusal).toContain("Reads still work; writes are refused");

    // CONTROL: the same reader on an UNMIGRATED store is not read-only, so the
    // refusal above is caused by the version stamp and nothing else.
    expect(formatVersionRefusal(loadConfig(twiningDirOf(copyStore(V1_FIXTURE))))).toBeNull();

    // The 2.x record surface is records/, and after migration it holds only
    // the frozen marker — an old client cannot even see the v3 history.
    expect(fs.readdirSync(path.join(tw, "records"))).toEqual(["RECORDS-FROZEN.md"]);
    expect(fs.existsSync(path.join(tw, "events"))).toBe(true);
  });

  it("the read-only gate is enforced at the write seam, not merely reported", async () => {
    const root = copyStore(V1_FIXTURE);
    await migrateToV3({ projectRoot: root });
    const tw = twiningDirOf(root);
    const { enterReadOnlyMode, exitReadOnlyMode, atomicWriteFileSync } = await import("../../src/storage/file-store.js");
    const refusal = formatVersionRefusal(loadConfig(tw)) as string;
    enterReadOnlyMode(refusal);
    try {
      expect(() => atomicWriteFileSync(path.join(tw, "records", "decisions", "x.json"), "{}")).toThrow(/newer than this/);
    } finally {
      exitReadOnlyMode();
    }
  });
});

describe("scope translation", () => {
  it("maps a legacy scope string onto the v3 tuple without inventing components", () => {
    const repo = "r_01M3C21DACT1V0000000000000";
    expect(scopeFromLegacy(repo, "src/catalog/", [])).toEqual({ repo, path: "src/catalog/" });
    expect(scopeFromLegacy(repo, "project", [])).toEqual({ repo });
    expect(scopeFromLegacy(repo, "", [])).toEqual({ repo });
    expect(scopeFromLegacy(repo, undefined, [])).toEqual({ repo });
    const flags: string[] = [];
    expect(scopeFromLegacy(repo, "/abs/path", flags)).toEqual({ repo, path: "abs/path" });
    expect(flags).toContain("scope_path_absolute:/abs/path");
    const traversal: string[] = [];
    scopeFromLegacy(repo, "a/../b", traversal);
    expect(traversal).toContain("scope_path_traversal:a/../b");
  });
});

/**
 * Regressions from the adversarial review of 52ba50d. Each test fails against
 * the code as it stood before its fix — they are pins, not decoration.
 */
describe("review regressions", () => {
  it("F1: a legacy record whose bytes are NOT valid UTF-8 is stored verbatim and still hashes to its own filename", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    const source = fs.readFileSync(path.join(tw, "decisions", `${NON_UTF8_ID}.json`));
    // The fixture is a real instrument: a UTF-8 round trip changes its bytes.
    expect(Buffer.from(source.toString("utf8"), "utf8").equals(source)).toBe(false);

    await migrateToV3({ projectRoot: root });
    const store = new EventStore({ twiningDir: tw });
    try {
      const created = (await store.history(NON_UTF8_ID)).find((e) => e.kind === "created");
      const att = created?.attachments?.[0] as { sha256: string; bytes: number };
      expect(att.sha256).toBe(sha(source));
      expect(att.bytes).toBe(source.length);

      const stored = fs.readFileSync(path.join(tw, "attachments", att.sha256.slice(0, 2), att.sha256));
      expect(stored.equals(source), "the stored blob is not byte-identical to the source").toBe(true);
      // …and the blob hashes to its own filename, the invariant the whole
      // byte-anchored design rests on.
      expect(sha(stored)).toBe(att.sha256);
      // The body IS a decode, and the difference is named rather than hidden.
      expect((await store.get(NON_UTF8_ID))?.legacy?.legacy_ambiguity).toContain("non_utf8_source_bytes");
    } finally {
      store.close();
    }
  });

  it("F1: a quarantined damaged blob is retained as BYTES, not as a UTF-8 round trip", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });
    for (const d of (readManifest(tw) as LegacyManifest).damaged) {
      const kept = fs.readFileSync(path.join(tw, "legacy", "quarantine", `${d.sha256}.bytes`));
      expect(sha(kept), `quarantined blob ${d.file} no longer hashes to its name`).toBe(d.sha256);
    }
  });

  it("F2: a decision archived out of `provisional` stays provisional under the archive flag", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    const report = await migrateToV3({ projectRoot: root });
    // It used to hard-fail the WHOLE run, not just this record.
    expect(report.ok).toBe(true);
    expect(report.verification?.status_mismatched).toEqual([]);

    const store = new EventStore({ twiningDir: tw });
    try {
      const rec = await store.get(ARCHIVED_FROM_PROVISIONAL_ID);
      expect(rec?.status).toBe("provisional");
      expect(rec?.archived).toBe(true);
      expect(rec?.archived_from).toBe("provisional"); // remembered, never guessed
      expect(rec?.authorizes_action).toBe(false);
      // Archival did not ratify it: no promotion anywhere in its history.
      expect((await store.history(ARCHIVED_FROM_PROVISIONAL_ID)).some((e) => e.kind === "promoted")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("F3: an `overridden_by` holding an ACTOR label is preserved, and not reported as absent", async () => {
    const root = copyStore(V1_FIXTURE);
    const tw = twiningDirOf(root);
    await migrateToV3({ projectRoot: root });
    const store = new EventStore({ twiningDir: tw });
    try {
      const ev = (await store.history(OVERRIDDEN_BY_ACTOR_ID)).find((e) => e.kind === "overridden");
      expect(ev).toBeDefined();
      // The value survives, in the structured field and in the audit string.
      expect(ev?.producer.asserted_actor).toBe("dave");
      expect(ev?.legacy?.legacy_ambiguity).toContain("overridden_by_not_a_record_id:dave");
      // …and the migration does NOT claim the legacy store lacked a value.
      expect(ev?.legacy?.legacy_ambiguity).not.toContain("overridden_without_overridden_by");
      // A record id that genuinely resolves still becomes a replacement edge.
      const resolved = (await store.history("01M3C21DVRDW10000000000000")).find((e) => e.kind === "overridden");
      expect((resolved?.payload as { replacement?: string }).replacement).toBe("01M3C21DACT1V0000000000000");
      // CONTROL: the genuinely-absent case keeps the original ambiguity word.
      const absent = (await store.history("01M3C21DVRDN10000000000000")).find((e) => e.kind === "overridden");
      expect(absent?.legacy?.legacy_ambiguity).toContain("overridden_without_overridden_by");
    } finally {
      store.close();
    }
  });

  it("F4: no file under src/ contains a control byte, so no source file is binary to git", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "vendor" || entry.name === "assets") continue; // third-party/binary by design
          walk(abs);
          continue;
        }
        if (!/\.(ts|js|mjs|json|md)$/.test(entry.name)) continue;
        const bytes = fs.readFileSync(abs);
        // \t (0x09), \n (0x0a) and \r (0x0d) are the only control bytes text
        // may carry; anything below 0x09 makes git classify the file as
        // BINARY, and an unreviewable diff is how a merge silently takes one
        // whole side. A raw NUL in a template literal did exactly this.
        for (let i = 0; i < bytes.length; i += 1) {
          if ((bytes[i] as number) < 0x09) {
            offenders.push(`${path.relative(SRC_ROOT, abs)}@${i}:0x${(bytes[i] as number).toString(16)}`);
            break;
          }
        }
      }
    };
    walk(SRC_ROOT);
    expect(offenders).toEqual([]);
  });

  it("F8/F11: contradictory and malformed CLI arguments are refused, never reinterpreted", async () => {
    const root = copyStore(V1_FIXTURE);
    const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
      const log = console.log;
      const err = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        return await fn();
      } finally {
        console.log = log;
        console.error = err;
      }
    };
    const { runMigrateCli, runEventsCli } = await import("../../src/migrate/cli.js");

    // `--reverse` targets format 1, so `--to 2 --reverse` names two targets.
    expect(await quiet(() => runMigrateCli(["--to", "2", "--reverse", "--project", root]))).toBe(2);
    // The store is untouched by a refused invocation.
    expect(loadConfig(twiningDirOf(root)).version).toBe(1);

    await quiet(() => migrateToV3({ projectRoot: root }));
    // A non-numeric --limit used to print the WHOLE archive.
    expect(await quiet(() => runEventsCli(["ls", "--limit", "abc", "--project", root]))).toBe(2);
    expect(await quiet(() => runEventsCli(["ls", "--limit", "0", "--project", root]))).toBe(2);
    expect(await quiet(() => runEventsCli(["ls", "--limit", "2", "--project", root]))).toBe(0);
  });
});
