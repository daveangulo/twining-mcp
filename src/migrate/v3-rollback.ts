/**
 * `twining rollback --to 2` — step back off the v3 build (ADR §10.7).
 *
 * Rollback is a VIEW change, never a data change. It regenerates a restricted
 * 2.x-shaped view into `records/` from the v3 projection and sets
 * `config.version: 2`; `events/`, `attachments/` and `cursors/` are left
 * exactly as they are and stay inspectable (`twining events ls|show`).
 *
 * Two honesty rules the oracle turns on:
 *
 *  - every regenerated file carries `legacy_view_of: <event id>` and, where the
 *    2.x shape cannot hold what v3 recorded, `v3_semantics_lost: [...]`. A
 *    reader of the rolled-back store can therefore always tell a real 2.x
 *    record from a narrowed view of a v3 one (C21 A-CUR-03).
 *  - the report separates DATA PRESERVATION from UNAVAILABLE FUNCTIONALITY
 *    (C21 A-RB-03). Functionality that stops working is never reported as data
 *    loss, and data that is still there is never reported as functionality.
 *
 * A tombstoned record is deliberately NOT written into the view: its content
 * is redacted in projections, and re-materialising a 2.x file for it would be
 * exactly the resurrection C20/C21 forbid. It is named in the report instead.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { EventStore } from "../events/event-store.js";
import type { SliceProjectedRecord } from "../events/projection.js";
import { atomicWriteFileSync, ensureDir } from "../storage/file-store.js";
import { stableStringify } from "../storage/sync/record-export.js";
import { setStorageBackend } from "./config-edit.js";
import { readMigrationState, type MigrationState } from "./v3-forward.js";

export interface LostSemantic {
  record_id: string;
  lost: string[];
}

export interface RollbackReport {
  ok: boolean;
  dry_run: boolean;
  /** What survived, and where it still is. Never mixed with the list below. */
  data_preservation: {
    events_retained: number;
    attachments_retained: number;
    cursors_retained: number;
    records_written: number;
    tombstoned_not_materialised: string[];
    inspect_with: string[];
    note: string[];
  };
  /** What stops working while rolled back. Never reported as data loss. */
  unavailable_functionality: Array<{ capability: string; detail: string }>;
  /** Per-record, only where the 2.x shape cannot carry what v3 holds. */
  v3_semantics_lost: LostSemantic[];
  files_written: string[];
  /**
   * rel path → sha256 of every view file this rollback wrote. The next forward
   * run reads it to tell "this file is the view I generated" from "someone
   * edited this file while rolled back" — without it, every regenerated view
   * looks like a rival body for its own record (§10.8).
   */
  view_manifest: Record<string, string>;
}

/** Every v3 capability a 2.x client cannot express, with the reason. */
export const UNAVAILABLE_WHILE_ROLLED_BACK: RollbackReport["unavailable_functionality"] = [
  { capability: "multi_part_records", detail: "per-part status, scope, evidence class and version have no 2.x field — a partially superseded record reads as whole" },
  { capability: "partial_supersession", detail: "`superseded.parts` cannot be expressed; the 2.x view shows the record's whole-record status only" },
  { capability: "evidence_class", detail: "2.x has no evidence class: a legacy_unverified statement and a human ruling look identical in the view" },
  { capability: "action_qualification", detail: "qualify() refuses while rolled back — the class and scope inputs it needs are not in the 2.x view" },
  { capability: "scoped_corrections", detail: "`corrected.applies_to` has no 2.x field; a per-scope answer collapses to one record-wide body" },
  { capability: "conflict_and_contested_state", detail: "explicit `conflicted` / contested annotations have no 2.x status; both sides read as ordinary records" },
  { capability: "revocation_and_retraction", detail: "`revoked` / `retracted` / `reinstated` have no 2.x status and are shown as archived with the loss named" },
  { capability: "attachments_and_signatures", detail: "source bytes and Ed25519 signatures are retained under attachments/ and events/ but are unreadable through the 2.x record shape" },
  { capability: "delivery_state_machine", detail: "exported/transferred/received/admitted/projected/injected receipts are retained in the journal but not surfaced by 2.x tools" },
  { capability: "scope_tuple", detail: "task, attempt, consumer and revision components collapse to the single 2.x `scope` string" },
];

const V2_STATUS_FOR: Record<string, { status: string; lost?: string }> = {
  active: { status: "active" },
  provisional: { status: "provisional" },
  superseded: { status: "superseded" },
  overridden: { status: "overridden" },
  archived: { status: "archived" },
  conflicted: { status: "active", lost: "status:conflicted" },
  restored_applicable: { status: "active", lost: "status:restored_applicable" },
  contested: { status: "superseded", lost: "status:contested" },
  revoked: { status: "archived", lost: "status:revoked" },
  retracted: { status: "archived", lost: "status:retracted" },
};

function lostFor(rec: SliceProjectedRecord): string[] {
  const lost: string[] = [];
  const mapped = V2_STATUS_FOR[rec.status];
  if (mapped?.lost) lost.push(mapped.lost);
  if (rec.parts && rec.parts.length > 0) lost.push("parts");
  if (rec.parts?.some((p) => p.status !== "applicable")) lost.push("part_level_lifecycle");
  if (rec.conflicts.length > 0) lost.push("conflicts");
  if (rec.contested.length > 0) lost.push("contested_annotations");
  if (rec.corrections.length > 0) lost.push("scoped_corrections");
  if (rec.evidence_class !== "legacy_unverified") lost.push(`evidence_class:${rec.evidence_class}`);
  if (rec.legacy?.legacy_ambiguity && rec.legacy.legacy_ambiguity.length > 0) lost.push("legacy_ambiguity");
  const s = rec.scope as Record<string, unknown>;
  if (s.task || s.attempt || s.consumer || s.revision) lost.push("scope_tuple");
  if (rec.superseded_by.length > 1) lost.push("multiple_supersessors");
  return [...new Set(lost)].sort();
}

/** The 2.x `scope` string for a v3 scope tuple (path, or "project"). */
function scopeString(rec: SliceProjectedRecord): string {
  const p = (rec.scope as { path?: string }).path;
  return p && p.length > 0 ? p : "project";
}

function viewFile(recordsDir: string, rec: SliceProjectedRecord, createdAt: string): string {
  switch (rec.record_type) {
    case "post":
      return path.join(recordsDir, "posts", createdAt.slice(0, 7), `${rec.record_id}.json`);
    case "entity":
      return path.join(recordsDir, "graph", "entities", `${rec.record_id}.json`);
    case "relation":
      return path.join(recordsDir, "graph", "relations", `${rec.record_id}.json`);
    case "handoff":
      return path.join(recordsDir, "handoffs", `${rec.record_id}.json`);
    default:
      return path.join(recordsDir, "decisions", `${rec.record_id}.json`);
  }
}

/** Build one 2.x-shaped record from a v3 projection row. */
export function v2ViewOf(rec: SliceProjectedRecord): Record<string, unknown> {
  const body = { ...rec.body };
  const lost = lostFor(rec);
  const base: Record<string, unknown> = {
    ...body,
    id: rec.record_id,
    scope: scopeString(rec),
    timestamp: rec.created_at,
    agent_id: (body.agent_id as string) ?? "unknown",
    // The two honesty markers: where this row came from, and what the 2.x
    // shape could not carry. A real 2.x record has neither.
    legacy_view_of: rec.version,
    ...(lost.length > 0 ? { v3_semantics_lost: lost } : {}),
  };

  if (rec.record_type === "decision") {
    const mapped = V2_STATUS_FOR[rec.status] ?? { status: "active" };
    base.status = rec.archived ? "archived" : mapped.status;
    if (rec.archived && rec.archived_from) base.archived_from = (V2_STATUS_FOR[rec.archived_from] ?? { status: rec.archived_from }).status;
    if (rec.superseded_by[0]) base.superseded_by = rec.superseded_by[0];
    if (rec.overridden_by) base.overridden_by = rec.overridden_by;
    if (rec.commits.length > 0) base.commit_hashes = rec.commits;
    base.confidence = (body.confidence as string) ?? "medium";
    base.reversible = body.reversible ?? true;
    base.affected_files = (body.affected_files as string[]) ?? [];
    base.affected_symbols = (body.affected_symbols as string[]) ?? [];
    base.constraints = (body.constraints as string[]) ?? [];
    base.alternatives = (body.alternatives as unknown[]) ?? [];
    base.depends_on = (body.depends_on as string[]) ?? [];
    base.domain = (body.domain as string) ?? "general";
    base.context = (body.context as string) ?? "";
    return base;
  }

  if (rec.record_type === "post") {
    // 1.x/2.x posts carry `entry_type`; a legacy value the v3 enum could not
    // hold was preserved in `legacy_entry_type` and is restored here.
    if (typeof body.legacy_entry_type === "string" && body.legacy_entry_type.length > 0) {
      base.entry_type = body.legacy_entry_type;
      delete (base as Record<string, unknown>).legacy_entry_type;
    }
    base.status = rec.status === "resolved" ? "resolved" : "open";
    if (rec.note !== undefined) base.resolution_note = rec.note;
    base.tags = (body.tags as string[]) ?? [];
    base.detail = (body.detail as string) ?? "";
    return base;
  }

  if (rec.record_type === "handoff") {
    base.created_at = rec.created_at;
    delete (base as Record<string, unknown>).timestamp;
    delete (base as Record<string, unknown>).agent_id;
    if (rec.status === "acknowledged" && base.acknowledged_by === undefined) base.acknowledged_by = "unknown";
    return base;
  }

  // entity / relation
  base.created_at = (body.created_at as string) ?? rec.created_at;
  delete (base as Record<string, unknown>).timestamp;
  delete (base as Record<string, unknown>).agent_id;
  delete (base as Record<string, unknown>).scope;
  return base;
}

export interface RollbackOptions {
  projectRoot: string;
  dryRun?: boolean;
}

/** Tolerates an unreadable path: a rollback REPORT must never fail to print. */
function countFiles(dir: string, ext?: string): number {
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(dir)) return 0;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name), ext);
    else if (!ext || entry.name.endsWith(ext)) n += 1;
  }
  return n;
}

export async function rollbackToV2(opts: RollbackOptions): Promise<RollbackReport> {
  const twiningDir = path.join(opts.projectRoot, ".twining");
  const state: MigrationState | null = readMigrationState(twiningDir);
  if (!state || (state.status !== "complete" && state.status !== "rolled_back")) {
    throw new Error("this store is not on v3 (no completed migration) — nothing to roll back");
  }

  const store = new EventStore({ twiningDir });
  const filesWritten: string[] = [];
  const viewManifest: Record<string, string> = {};
  const lostList: LostSemantic[] = [];
  const tombstoned: string[] = [];
  try {
    await store.admit();
    await store.project();
    const records = await store.query({ include_archived: true, include_retired: true });
    const recordsDir = path.join(twiningDir, "records");

    for (const rec of records) {
      if (rec.record_type === "principal" || rec.record_type === "membership") continue; // v3-only infrastructure
      if (rec.status === "tombstoned") {
        tombstoned.push(rec.record_id);
        continue;
      }
      const view = v2ViewOf(rec);
      const lost = view.v3_semantics_lost as string[] | undefined;
      if (lost && lost.length > 0) lostList.push({ record_id: rec.record_id, lost });
      const file = viewFile(recordsDir, rec, rec.created_at);
      const rel = path.relative(twiningDir, file).split(path.sep).join("/");
      const bytes = stableStringify(view);
      filesWritten.push(rel);
      viewManifest[rel] = createHash("sha256").update(bytes).digest("hex");
      if (!opts.dryRun) {
        ensureDir(path.dirname(file));
        atomicWriteFileSync(file, bytes);
      }
    }

    const report: RollbackReport = {
      ok: true,
      dry_run: opts.dryRun === true,
      data_preservation: {
        events_retained: countFiles(path.join(twiningDir, "events"), ".json"),
        attachments_retained: countFiles(path.join(twiningDir, "attachments")),
        cursors_retained: countFiles(path.join(twiningDir, "cursors"), ".json"),
        records_written: filesWritten.length,
        tombstoned_not_materialised: tombstoned,
        inspect_with: ["twining events ls", "twining events show <event-id>", "twining migrate-status"],
        note: [
          "events/, attachments/ and cursors/ are UNCHANGED and remain the authority",
          "every regenerated records/ file carries legacy_view_of and, where narrowed, v3_semantics_lost",
          "a records/ file edited while rolled back is preserved by the next `twining migrate --to 3` as a new legacy event",
        ],
      },
      unavailable_functionality: UNAVAILABLE_WHILE_ROLLED_BACK,
      v3_semantics_lost: lostList.sort((a, b) => (a.record_id < b.record_id ? -1 : 1)),
      files_written: filesWritten.sort(),
      view_manifest: viewManifest,
    };

    if (!opts.dryRun) {
      fs.rmSync(path.join(recordsDir, "RECORDS-FROZEN.md"), { force: true });
      setStorageBackend(twiningDir, "sqlite", { formatVersion: 2 });
      const next: MigrationState = { ...state, status: "rolled_back", rolled_back_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      ensureDir(path.join(twiningDir, "legacy"));
      atomicWriteFileSync(path.join(twiningDir, "legacy", "migration-state.json"), JSON.stringify(next, null, 2) + "\n");
      atomicWriteFileSync(path.join(twiningDir, "legacy", "rollback-report.json"), JSON.stringify(report, null, 2) + "\n");
      atomicWriteFileSync(path.join(twiningDir, "legacy", "view-manifest.json"), JSON.stringify(viewManifest, null, 2) + "\n");
      atomicWriteFileSync(path.join(twiningDir, "legacy", "ROLLBACK-REPORT.md"), renderRollbackReport(report));
    }
    return report;
  } finally {
    store.close();
  }
}

export function renderRollbackReport(report: RollbackReport): string {
  const d = report.data_preservation;
  return [
    "# Rollback report — v3 → 2",
    "",
    "## Data preservation",
    "",
    `- events retained: ${d.events_retained}`,
    `- attachments retained: ${d.attachments_retained}`,
    `- cursors retained: ${d.cursors_retained}`,
    `- 2.x view files written: ${d.records_written}`,
    `- tombstoned records deliberately NOT materialised: ${d.tombstoned_not_materialised.length}${d.tombstoned_not_materialised.length > 0 ? ` (${d.tombstoned_not_materialised.join(", ")})` : ""}`,
    ...d.note.map((n) => `- ${n}`),
    "",
    `Inspect the retained v3 data with: ${d.inspect_with.join(", ")}`,
    "",
    "## Unavailable functionality (NOT data loss)",
    "",
    ...report.unavailable_functionality.map((u) => `- **${u.capability}** — ${u.detail}`),
    "",
    "## Records whose v3 semantics the 2.x view cannot carry",
    "",
    ...(report.v3_semantics_lost.length === 0
      ? ["(none)"]
      : report.v3_semantics_lost.map((l) => `- \`${l.record_id}\`: ${l.lost.join(", ")}`)),
    "",
  ].join("\n");
}
