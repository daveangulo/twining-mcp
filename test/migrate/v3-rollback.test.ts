/**
 * `twining rollback --to 2` and the forward recovery after it — ADR §10.7/§10.8.
 *
 * The thing being tested is that rollback is a VIEW change: the events, the
 * attachments and the cursors are untouched, the 2.x files that appear are
 * labelled as views, and everything the 2.x shape cannot carry is named rather
 * than quietly dropped.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { migrateToV3, migrateStatus, readIdMap } from "../../src/migrate/v3-forward.js";
import { rollbackToV2, renderRollbackReport, UNAVAILABLE_WHILE_ROLLED_BACK, type RollbackReport } from "../../src/migrate/v3-rollback.js";
import { EventStore } from "../../src/events/event-store.js";
import { loadConfig, formatVersionRefusal } from "../../src/config.js";
import { runEventsCli } from "../../src/migrate/cli.js";
import { cleanupStores, copyStore, readJson, snapshotBytes, twiningDirOf, V1_FIXTURE } from "./v3-helpers.js";

afterAll(cleanupStores);

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** A migrated store, ready to roll back. */
async function migrated(): Promise<{ root: string; tw: string }> {
  const root = copyStore(V1_FIXTURE, "v3rb");
  await migrateToV3({ projectRoot: root });
  return { root, tw: twiningDirOf(root) };
}

describe("rollback --to 2 (§10.7)", () => {
  it("refuses on a store that never completed a v3 migration", async () => {
    const root = copyStore(V1_FIXTURE, "v3rb");
    await expect(rollbackToV2({ projectRoot: root })).rejects.toThrow(/not on v3/);
  });

  it("regenerates a 2.x view, sets config.version 2, and leaves events/attachments/cursors intact", async () => {
    const { root, tw } = await migrated();
    const eventsBefore = snapshotBytes(path.join(tw, "events"));
    const attachmentsBefore = snapshotBytes(path.join(tw, "attachments"));
    const cursorsBefore = snapshotBytes(path.join(tw, "cursors"));

    const report = await rollbackToV2({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(loadConfig(tw).version).toBe(2);
    // The three retained trees are BYTE-identical, not merely present.
    expect(snapshotBytes(path.join(tw, "events"))).toEqual(eventsBefore);
    expect(snapshotBytes(path.join(tw, "attachments"))).toEqual(attachmentsBefore);
    expect(snapshotBytes(path.join(tw, "cursors"))).toEqual(cursorsBefore);
    expect(report.data_preservation.events_retained).toBe(Object.keys(eventsBefore).length);
    expect(report.data_preservation.attachments_retained).toBe(Object.keys(attachmentsBefore).length);
    // The frozen marker goes away: records/ is the live view again.
    expect(fs.existsSync(path.join(tw, "records", "RECORDS-FROZEN.md"))).toBe(false);
    expect(migrateStatus(tw).migration).toBe("rolled_back");
  });

  it("every regenerated file is labelled `legacy_view_of`, and is 2.x-shaped", async () => {
    const { root, tw } = await migrated();
    const report = await rollbackToV2({ projectRoot: root });

    expect(report.files_written.length).toBeGreaterThan(15);
    for (const rel of report.files_written) {
      const view = readJson<Record<string, unknown>>(path.join(tw, rel));
      expect(view.legacy_view_of, `${rel} has no legacy_view_of`).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(view.id).toBe(path.basename(rel, ".json"));
    }

    // 2.x decision shape, with the lifecycle fields a 2.x reader expects.
    const decision = readJson<Record<string, unknown>>(path.join(tw, "records", "decisions", "01M3C21DSPSW10000000000000.json"));
    expect(decision.status).toBe("superseded");
    expect(decision.superseded_by).toBe("01M3C21DACT1V0000000000000");
    expect(decision.scope).toBe("src/catalog/");
    expect(decision.confidence).toBeDefined();
    expect(Array.isArray(decision.affected_files)).toBe(true);

    // An archived decision comes back as 2.x `archived` with archived_from.
    const archived = readJson<Record<string, unknown>>(path.join(tw, "records", "decisions", "01M3C21DARCW10000000000000.json"));
    expect(archived.status).toBe("archived");
    expect(archived.archived_from).toBe("active");

    // The post entry_type the v3 enum could not hold is RESTORED on the way out.
    const post = readJson<Record<string, unknown>>(path.join(tw, "records", "posts", "2026-08", "01M3C21PKYND10000000000000.json"));
    expect(post.entry_type).toBe("decision");
    expect(post.legacy_entry_type).toBeUndefined();
  });

  it("names what the 2.x shape cannot carry, per record", async () => {
    const { root, tw } = await migrated();
    const report = await rollbackToV2({ projectRoot: root });

    const lost = new Map(report.v3_semantics_lost.map((l) => [l.record_id, l.lost]));
    // A record whose legacy ambiguity has no 2.x field says so.
    expect(lost.get("01M3C21DMSMT10000000000000")).toContain("legacy_ambiguity");
    // The conflicted pair's annotation has no 2.x representation.
    expect(lost.get("01M3C21DDPCT10000000000000")).toContain("contested_annotations");
    // …and the same list is on the file itself, not only in the report.
    const onDisk = readJson<Record<string, unknown>>(path.join(tw, "records", "decisions", "01M3C21DMSMT10000000000000.json"));
    expect(onDisk.v3_semantics_lost).toContain("legacy_ambiguity");
    // A record with nothing to lose carries no marker at all.
    const plain = readJson<Record<string, unknown>>(path.join(tw, "records", "decisions", "01M3C21DACT1V0000000000000.json"));
    expect(plain.v3_semantics_lost).toBeUndefined();
  });

  it("reports data preservation and unavailable functionality as SEPARATE, non-empty sections", async () => {
    const { root } = await migrated();
    const report = await rollbackToV2({ projectRoot: root });

    expect(report.data_preservation.events_retained).toBeGreaterThan(0);
    expect(report.unavailable_functionality.length).toBeGreaterThan(0);
    const capabilities = report.unavailable_functionality.map((u) => u.capability);
    // The three the oracle names explicitly.
    expect(capabilities).toContain("multi_part_records");
    expect(capabilities).toContain("partial_supersession");
    expect(capabilities).toContain("attachments_and_signatures");
    expect(capabilities).toContain("action_qualification");

    // The rendered report keeps them apart, and never calls one the other.
    const md = renderRollbackReport(report);
    const dataAt = md.indexOf("## Data preservation");
    const funcAt = md.indexOf("## Unavailable functionality");
    expect(dataAt).toBeGreaterThan(-1);
    expect(funcAt).toBeGreaterThan(dataAt);
    expect(md).toContain("(NOT data loss)");
    expect(md.slice(dataAt, funcAt)).not.toContain("unavailable");
  });

  it("the retained v3 data is LISTABLE and READABLE while rolled back", async () => {
    const { root, tw } = await migrated();
    await rollbackToV2({ projectRoot: root });

    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      expect(runEventsCli(["ls", "--project", root])).toBe(0);
      const someEvent = lines.find((l) => l.startsWith("01M3C21DACT1V"));
      expect(someEvent, "the migrated record's event is listed").toBeDefined();
      lines.length = 0;
      expect(runEventsCli(["show", "01M3C21DACT1V0000000000000", "--project", root])).toBe(0);
    } finally {
      console.log = realLog;
    }
    const shown = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(shown.id).toBe("01M3C21DACT1V0000000000000");
    expect(shown.kind).toBe("created");
    expect((shown.attachments as Array<{ sha256: string }>)[0]?.sha256).toBeDefined();

    // …and the attachment bytes it names can still be read out.
    const attSha = (shown.attachments as Array<{ sha256: string }>)[0]!.sha256;
    const bytes = fs.readFileSync(path.join(tw, "attachments", attSha.slice(0, 2), attSha));
    expect(sha(bytes)).toBe(attSha);
  });

  it("a 2.x client is NOT read-only while rolled back — that is the point of rolling back", async () => {
    const { root, tw } = await migrated();
    expect(formatVersionRefusal(loadConfig(tw))).not.toBeNull(); // v3: read-only
    await rollbackToV2({ projectRoot: root });
    expect(formatVersionRefusal(loadConfig(tw))).toBeNull(); // v2: writable again
  });

  it("--dry-run writes no COMMITTED state (the derived database is exempt, as in 2.x reverse)", async () => {
    const { root, tw } = await migrated();
    // `store/` holds the gitignored projection database. A dry run opens it to
    // read an accurate projection, exactly as `migrate --reverse --dry-run`
    // already does — judged a non-blocking Low on the 2.x migration because
    // the database is a derived cache and accurate dry-run counts require it.
    // Everything a user could commit must be byte-identical.
    const committed = (dir: string): Record<string, string> =>
      Object.fromEntries(Object.entries(snapshotBytes(dir)).filter(([rel]) => !rel.startsWith("store/")));

    const before = committed(tw);
    const report = await rollbackToV2({ projectRoot: root, dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.files_written.length).toBeGreaterThan(0); // it still REPORTS the plan
    expect(committed(tw)).toEqual(before);
    expect(loadConfig(tw).version).toBe(3);
    expect(fs.existsSync(path.join(tw, "legacy", "view-manifest.json"))).toBe(false);
    expect(fs.existsSync(path.join(tw, "records", "RECORDS-FROZEN.md"))).toBe(true);
  });
});

describe("forward recovery after rollback (§10.8)", () => {
  it("re-migrating is a no-op for the events that already exist", async () => {
    const { root, tw } = await migrated();
    const eventsBefore = snapshotBytes(path.join(tw, "events"));
    const idMapBefore = readIdMap(tw);

    await rollbackToV2({ projectRoot: root });
    const recovery = await migrateToV3({ projectRoot: root });

    expect(recovery.ok).toBe(true);
    expect(recovery.counts.post_rollback_writes).toBe(0);
    expect(recovery.counts.duplicate_suppressed).toBeGreaterThan(0);
    expect(snapshotBytes(path.join(tw, "events"))).toEqual(eventsBefore);
    expect(readIdMap(tw)).toEqual(idMapBefore);
    expect(loadConfig(tw).version).toBe(3);
    expect(migrateStatus(tw).migration).toBe("complete");
  });

  it("a records/ file CHANGED while rolled back is preserved as a new legacy event", async () => {
    const { root, tw } = await migrated();
    await rollbackToV2({ projectRoot: root });

    const target = path.join(tw, "records", "decisions", "01M3C21DACT1V0000000000000.json");
    const edited = readJson<Record<string, unknown>>(target);
    edited.summary = "edited by a 2.x client while rolled back";
    fs.writeFileSync(target, `${JSON.stringify(edited, null, 2)}\n`);

    const recovery = await migrateToV3({ projectRoot: root });
    expect(recovery.ok).toBe(true);
    expect(recovery.counts.post_rollback_writes).toBe(1);

    const store = new EventStore({ twiningDir: tw });
    try {
      const all = await store.query({ include_archived: true, include_retired: true });
      const successor = all.find((r) => (r.legacy?.legacy_ambiguity ?? []).includes("post_rollback_write_recorded_as_successor"));
      expect(successor, "the post-rollback write became its own record").toBeDefined();
      expect(successor?.body.summary).toBe("edited by a 2.x client while rolled back");

      // The original keeps its id and its history, and points at the successor.
      const original = await store.get("01M3C21DACT1V0000000000000");
      expect(original).not.toBeNull();
      expect(original?.status).toBe("superseded");
      expect(original?.superseded_by).toEqual([successor?.record_id]);
      expect(original?.body.summary).toBe("catalog output publishes from the nightly build");
    } finally {
      store.close();
    }
  });

  it("re-importing a second time adds no duplicate", async () => {
    const { root, tw } = await migrated();
    await rollbackToV2({ projectRoot: root });
    const target = path.join(tw, "records", "decisions", "01M3C21DACT1V0000000000000.json");
    const edited = readJson<Record<string, unknown>>(target);
    edited.summary = "edited once";
    fs.writeFileSync(target, `${JSON.stringify(edited, null, 2)}\n`);

    await migrateToV3({ projectRoot: root });
    const eventsAfterFirst = snapshotBytes(path.join(tw, "events"));
    const second = await migrateToV3({ projectRoot: root });

    expect(second.counts.post_rollback_writes).toBe(0);
    expect(snapshotBytes(path.join(tw, "events"))).toEqual(eventsAfterFirst);

    const store = new EventStore({ twiningDir: tw });
    try {
      const all = await store.query({ include_archived: true, include_retired: true });
      expect(new Set(all.map((r) => r.record_id)).size).toBe(all.length);
      const successors = all.filter((r) => (r.legacy?.legacy_ambiguity ?? []).includes("post_rollback_write_recorded_as_successor"));
      expect(successors).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("an UNCHANGED view is not mistaken for a rival body of its own record", async () => {
    // The defect this pins: a regenerated view necessarily differs from the
    // legacy original, so without the rollback's view manifest every migrated
    // record collides with itself and the store fills with phantom conflicts.
    const { root, tw } = await migrated();
    const conflictsBefore = (await migrateToV3({ projectRoot: root })).counts.conflicts;
    await rollbackToV2({ projectRoot: root });
    const recovery = await migrateToV3({ projectRoot: root });
    expect(recovery.counts.conflicts).toBe(conflictsBefore);
    expect(recovery.counts.rivals).toBe(1); // the one genuine fixture conflict, unchanged
    const store = new EventStore({ twiningDir: tw });
    try {
      const contested = (await store.query({ include_archived: true, include_retired: true })).filter((r) => r.contested.length > 0);
      expect(contested).toHaveLength(2); // the fixture's conflicting pair, and nothing else
    } finally {
      store.close();
    }
  });
});

describe("the unavailable-functionality list is machine-readable", () => {
  it("is a structured list with a capability and a reason on every entry", () => {
    expect(UNAVAILABLE_WHILE_ROLLED_BACK.length).toBeGreaterThanOrEqual(8);
    for (const entry of UNAVAILABLE_WHILE_ROLLED_BACK) {
      expect(entry.capability).toMatch(/^[a-z_]+$/);
      expect(entry.detail.length).toBeGreaterThan(20);
    }
    const report = { unavailable_functionality: UNAVAILABLE_WHILE_ROLLED_BACK } as RollbackReport;
    expect(new Set(report.unavailable_functionality.map((u) => u.capability)).size).toBe(UNAVAILABLE_WHILE_ROLLED_BACK.length);
  });
});
