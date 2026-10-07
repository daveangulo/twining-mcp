/**
 * `twining migrate --to 3` — legacy store → v3 event store (ADR §10).
 *
 * Five steps, each idempotent, each recorded in `legacy/migration-state.json`
 * so an interrupted run resumes instead of restarting:
 *
 *   1 manifest  sha256 + length of every legacy file, every id, every
 *               relationship field → `legacy/manifest.json` (also what
 *               `--dry-run` produces, and nothing else)
 *   2 events    one `created` event per legacy record (payload = the record
 *               minus its lifecycle fields; attachment = the legacy bytes
 *               verbatim, `source_kind: legacy_record`; `legacy_unverified`;
 *               `asserted_actor` = the legacy `agent_id`; `source` from the
 *               legacy provenance) plus the lifecycle events reconstructed
 *               from the status fields, every one flagged
 *               `derived_from_legacy_snapshot: true`
 *   3 idmap     `legacy/id-map.json`: legacy id → created event id (identity)
 *               plus every derived event id
 *   4 verify    rebuild the projection and compare status + relationships
 *               (subset containment) and every attachment hash against the
 *               manifest
 *   5 finalize  `store.json`, `config.version: 3`, `records/RECORDS-FROZEN.md`
 *
 * Two rules hold across all of it: legacy files are never modified (they are
 * their own backup), and nothing is ever invented — a value the legacy store
 * did not carry stays absent and is named in `legacy.legacy_ambiguity`, never
 * filled with the migrator's identity or the migration clock (C21 A-REC-05).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { EventStore } from "../events/event-store.js";
import { computeEventDigest, ENVELOPE_V, STORE_FORMAT_VERSION } from "../contracts/index.js";
import type { Scope } from "../contracts/scope.js";
import { atomicWriteFileSync, ensureDir } from "../storage/file-store.js";
import { setStorageBackend } from "./config-edit.js";
import {
  scanLegacyStore,
  sha256Of,
  type LegacyRecord,
  type LegacyScan,
  type RelationshipFields,
} from "./legacy-scan.js";

// ------------------------------------------------------------------- shapes

export type MigrationStep = "manifest" | "events" | "idmap" | "verify" | "finalize";
export const MIGRATION_STEPS: MigrationStep[] = ["manifest", "events", "idmap", "verify", "finalize"];

export interface MigrationIdentity {
  store_id: string;
  repo_id: string;
  principal: string;
  host: string;
}

export interface MigrationState {
  target_format: 3;
  /** `incomplete` until finalize succeeds — an interrupted run never reads complete. */
  status: "incomplete" | "complete" | "rolled_back";
  completed_steps: MigrationStep[];
  identity: MigrationIdentity;
  started_at: string;
  updated_at: string;
  counts: Record<string, number>;
  /** Set by `rollback --to 2`; cleared by the next forward run. */
  rolled_back_at?: string;
}

export interface ManifestFileEntry {
  sha256: string;
  bytes: number;
}

export interface LegacyManifest {
  format: 3;
  generated_from: string;
  layouts: Array<"v1" | "v2">;
  /** rel path → { sha256, bytes } for EVERY legacy file. */
  files: Record<string, ManifestFileEntry>;
  /** legacy id → { kind, file, sha256 } for every recoverable record. */
  ids: Record<string, { kind: string; file: string; sha256: string; anchor?: string }>;
  /** legacy id → every relationship field it carried. */
  relationships: Record<string, RelationshipFields>;
  /** Files that could not be interpreted; retained, never reconstructed. */
  damaged: LegacyScan["damaged"];
  /** Ids declared by more than one file with different bytes. */
  conflicts: LegacyScan["conflicts"];
}

export interface IdMapEntry {
  /** Identity: the legacy ULID IS the created event id. */
  created: string;
  kind: string;
  derived: Array<{ id: string; kind: string }>;
  /** Present only for a rival body of a conflicting declared id. */
  rival_of?: string;
  /**
   * Why this record exists beside another. `duplicate_rival` — two legacy
   * files declared one id. `post_rollback` — a records/ file was edited while
   * rolled back and the new body became its own record (§10.8). Durable,
   * because verification on a LATER run has to know that the original's
   * legacy file still says `active` while the projection correctly says
   * `superseded`; deriving that from the current run's actions made every
   * re-run after a recovery fail the gate forever.
   */
  origin?: "duplicate_rival" | "post_rollback";
}

export interface MigrateV3Report {
  ok: boolean;
  dry_run: boolean;
  state: MigrationState;
  manifest_path: string;
  counts: {
    legacy_files: number;
    legacy_records: number;
    created_events: number;
    derived_events: number;
    rivals: number;
    damaged: number;
    conflicts: number;
    post_rollback_writes: number;
    duplicate_suppressed: number;
  };
  /** Named, machine-readable findings — the same list the dry run reports. */
  findings: Array<{ kind: string; subject: string; detail: string }>;
  verification: VerificationResult | null;
  notes: string[];
}

export interface VerificationResult {
  ok: boolean;
  records_checked: number;
  attachments_checked: number;
  missing: string[];
  status_mismatched: Array<{ id: string; expected: string; actual: string }>;
  relationships_missing: Array<{ id: string; field: string; value: string }>;
  attachment_mismatched: string[];
}

export interface MigrateV3Options {
  projectRoot: string;
  dryRun?: boolean;
  /** Test hooks — the SIGKILL harness kills the process from afterEvent. */
  hooks?: { afterEvent?: (n: number, eventId: string) => void; afterStep?: (step: MigrationStep) => void };
}

// -------------------------------------------------------------- identifiers

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID-shaped identifier derived deterministically from `seed`. Derived
 * lifecycle events must keep the SAME id across a resume, a rerun and a clean
 * control run, or idempotency (C21 A-INT-03) is impossible; a minted ULID
 * would differ every run. Collision with a legacy ULID is a 2^-130 event.
 */
export function derivedId(seed: string): string {
  const h = createHash("sha256").update(`twining-v3-migration\u0000${seed}`).digest();
  let out = "";
  for (let i = 0; i < 26; i += 1) out += CROCKFORD[(h[i] as number) % 32];
  return out;
}

const prefixedId = (prefix: string, seed: string): string => `${prefix}_${derivedId(seed)}`;

// ---------------------------------------------------------------- store.json

/**
 * What `.twining/store.json` may carry. Two writers, two shapes: `twining
 * identity init` (ensureStoreDescriptor) writes `store_id`, `repo_ids`,
 * `format`, `created_at` and NO `repo_id`; finalize below writes both keys.
 */
interface StoreJsonShape {
  store_id?: unknown;
  repo_id?: unknown;
  repo_ids?: unknown;
  format?: unknown;
  created_at?: unknown;
  migrated_from?: unknown;
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The parsed descriptor, or null when the file is absent, unreadable or not an object. */
function readStoreJson(twiningDir: string): StoreJsonShape | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeJsonPath(twiningDir), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as StoreJsonShape) : null;
  } catch {
    return null;
  }
}

/**
 * The repo id a descriptor declares: `repo_id` when present, else the first of
 * `repo_ids` — first declared wins, as `repoIdFor` (adapter runtime) and
 * `readStoreIdentity` (retrieval) resolve it, so a migration run AFTER
 * `identity init` adopts the id every event already cites instead of minting
 * a second one. Mirrors src/retrieval/store-identity.ts's rule rather than
 * importing across layers.
 */
function declaredRepoId(store: StoreJsonShape): string | undefined {
  if (nonEmptyString(store.repo_id)) return store.repo_id;
  if (Array.isArray(store.repo_ids) && nonEmptyString(store.repo_ids[0])) return store.repo_ids[0];
  return undefined;
}

// ------------------------------------------------------------------- paths

const legacyDir = (twiningDir: string): string => path.join(twiningDir, "legacy");
const statePath = (twiningDir: string): string => path.join(legacyDir(twiningDir), "migration-state.json");
const manifestPath = (twiningDir: string): string => path.join(legacyDir(twiningDir), "manifest.json");
const idMapPath = (twiningDir: string): string => path.join(legacyDir(twiningDir), "id-map.json");
const quarantineDir = (twiningDir: string): string => path.join(legacyDir(twiningDir), "quarantine");
const viewManifestPath = (twiningDir: string): string => path.join(legacyDir(twiningDir), "view-manifest.json");
const storeJsonPath = (twiningDir: string): string => path.join(twiningDir, "store.json");
const attachmentPath = (twiningDir: string, sha: string): string => path.join(twiningDir, "attachments", sha.slice(0, 2), sha);

export function readMigrationState(twiningDir: string): MigrationState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(twiningDir), "utf8")) as MigrationState;
  } catch {
    return null;
  }
}

export function readIdMap(twiningDir: string): Record<string, IdMapEntry> {
  try {
    return JSON.parse(fs.readFileSync(idMapPath(twiningDir), "utf8")) as Record<string, IdMapEntry>;
  } catch {
    return {};
  }
}

/** rel → sha256 of the 2.x view files the last rollback generated. */
export function readViewManifest(twiningDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(viewManifestPath(twiningDir), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function readManifest(twiningDir: string): LegacyManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(twiningDir), "utf8")) as LegacyManifest;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  atomicWriteFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/**
 * The migration's own identity. Minted once and persisted, so a resumed or
 * repeated run produces byte-identical events (and therefore duplicate-
 * suppressed appends) rather than a second parallel history.
 *
 * Precedence is persisted state, then the descriptor, then a path-seeded
 * pair — and the first rule is deliberately NOT a heal. A store that ran
 * `identity init` and was then migrated by a pre-591fcf63 run (which read
 * only `repo_id`, minted a seeded pair and overwrote store.json with it)
 * keeps the seeded pair on every rerun: the init ids are gone from store.json,
 * so finalize's union cannot restore them, while the events minted before
 * that migration (and the ceremony membership) still cite the init repo id.
 * Healing means choosing which id the checkout cites from now on — a
 * deliberate edit of store.json and legacy/migration-state.json, not a call a
 * rerun may make on its own. `twining doctor` reports the shape as
 * `repo_ids_undeclared`.
 */
function resolveIdentity(twiningDir: string, prior: MigrationState | null): MigrationIdentity {
  if (prior?.identity) return prior.identity;
  // An existing descriptor — `identity init` ran first, or a finalize did —
  // already owns the ids events cite. Adopt them; never mint a rival pair.
  const store = readStoreJson(twiningDir);
  const declared = store ? declaredRepoId(store) : undefined;
  if (store && nonEmptyString(store.store_id) && declared !== undefined) {
    return {
      store_id: store.store_id,
      repo_id: declared,
      principal: prefixedId("p", `${store.store_id}:migrator`),
      host: prefixedId("h", `${store.store_id}:migrator-host`),
    };
  }
  // Seeded from the store path so two runs against one store agree, and two
  // different stores never collide.
  const seed = path.resolve(twiningDir);
  return {
    store_id: prefixedId("s", `${seed}:store`),
    repo_id: prefixedId("r", `${seed}:repo`),
    principal: prefixedId("p", `${seed}:migrator`),
    host: prefixedId("h", `${seed}:migrator-host`),
  };
}

// ------------------------------------------------------------------- scopes

const SHA40 = /^[0-9a-f]{40}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Legacy `scope` is a free string; v3 scope is a tuple. "project" is repo-wide. */
export function scopeFromLegacy(repoId: string, legacyScope: unknown, ambiguity: string[]): Scope {
  const raw = typeof legacyScope === "string" ? legacyScope.trim() : "";
  if (raw === "" || raw === "project" || raw === "/") return { repo: repoId };
  let p = raw.replace(/^\.\//, "");
  if (p.startsWith("/")) {
    ambiguity.push(`scope_path_absolute:${raw}`);
    p = p.replace(/^\/+/, "");
  }
  if (p.includes("..")) {
    ambiguity.push(`scope_path_traversal:${raw}`);
    p = p.split("/").filter((s) => s !== "..").join("/");
  }
  if (p === "") return { repo: repoId };
  return { repo: repoId, path: p };
}

function sourceFromLegacy(body: Record<string, unknown>): { branch?: string; commit?: string } | undefined {
  const prov = body.provenance as { branch?: unknown; commit_sha?: unknown } | undefined;
  if (!prov || typeof prov !== "object") return undefined;
  const out: { branch?: string; commit?: string } = {};
  if (typeof prov.branch === "string" && prov.branch.length > 0) out.branch = prov.branch;
  if (typeof prov.commit_sha === "string" && SHA40.test(prov.commit_sha)) out.commit = prov.commit_sha;
  return Object.keys(out).length > 0 ? out : undefined;
}

// -------------------------------------------------------------- body shapes

const V3_ENTRY_TYPES = new Set(["need", "offer", "finding", "constraint", "question", "answer", "status", "artifact", "warning"]);

const DECISION_LIFECYCLE_FIELDS = [
  "id",
  "timestamp",
  "agent_id",
  "scope",
  "provenance",
  "status",
  "superseded_by",
  "overridden_by",
  "override_reason",
  "archived_from",
  "promoted_by",
  "promoted_at",
  "amendments",
  "embedding_id",
  "assembled_before",
];

const POST_LIFECYCLE_FIELDS = [
  "id",
  "timestamp",
  "agent_id",
  "scope",
  "provenance",
  "status",
  "resolved_at",
  "resolved_by",
  "resolution_note",
  "embedding_id",
  "origin",
];

function omit(body: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** Placeholder for a value the legacy store did not carry. Never a guess. */
const NOT_RECORDED = "(not recorded in the legacy store)";

function decisionPayload(rec: LegacyRecord, ambiguity: string[]): Record<string, unknown> {
  const body = omit(rec.body, DECISION_LIFECYCLE_FIELDS);
  if (typeof body.summary !== "string" || body.summary.length === 0) {
    ambiguity.push("summary_not_recorded");
    body.summary = NOT_RECORDED;
  }
  if (typeof body.rationale !== "string" || body.rationale.length === 0) {
    ambiguity.push("rationale_not_recorded");
    body.rationale = NOT_RECORDED;
  }
  if (Array.isArray(body.depends_on)) {
    const keep = (body.depends_on as unknown[]).filter((d): d is string => typeof d === "string" && ULID_RE.test(d));
    if (keep.length !== (body.depends_on as unknown[]).length) {
      ambiguity.push("depends_on_contains_non_ulid");
      body.legacy_depends_on = body.depends_on;
    }
    body.depends_on = keep;
  }
  if (Array.isArray(body.alternatives)) {
    body.alternatives = (body.alternatives as Array<Record<string, unknown>>).map((a) => ({
      ...a,
      option: typeof a.option === "string" && a.option.length > 0 ? a.option : NOT_RECORDED,
    }));
  }
  // The created payload carries the status the record STARTED in; the derived
  // lifecycle events carry it the rest of the way. A record archived out of
  // `provisional` therefore has to be created provisional — otherwise the
  // projection starts it `active`, the archive flag lands beside the wrong
  // status, and the provisional-ness is lost with nothing recording that it
  // was (housekeeping.ts writes archived_from on every archive_stale sweep,
  // so this is an ordinary store shape, not a synthetic one).
  const archivedFrom = typeof rec.body.archived_from === "string" ? rec.body.archived_from : undefined;
  if (rec.body.status === "provisional" || archivedFrom === "provisional") body.status = "provisional";
  else if (typeof rec.body.promoted_by === "string" || typeof rec.body.promoted_at === "string") body.status = "provisional";
  return body;
}

function postPayload(rec: LegacyRecord, ambiguity: string[]): Record<string, unknown> {
  const body = omit(rec.body, POST_LIFECYCLE_FIELDS);
  const entryType = typeof body.entry_type === "string" ? body.entry_type : "";
  if (!V3_ENTRY_TYPES.has(entryType)) {
    // The v3 post body enum dropped 1.x's `decision` entry type. Coercing
    // silently would relabel the record, so the original value survives
    // verbatim in the body AND in the attachment bytes, and the coercion is
    // named. (Proposed contract diff: accept `decision` for legacy posts.)
    ambiguity.push(`entry_type_not_representable:${entryType || "(absent)"}`);
    body.legacy_entry_type = entryType;
    body.entry_type = "status";
  }
  if (typeof body.summary !== "string" || body.summary.length === 0) {
    ambiguity.push("summary_not_recorded");
    body.summary = NOT_RECORDED;
  } else if ((body.summary as string).length > 200) {
    ambiguity.push("summary_truncated_to_200");
    body.legacy_summary = body.summary;
    body.summary = (body.summary as string).slice(0, 200);
  }
  if (Array.isArray(body.relates_to)) {
    const keep = (body.relates_to as unknown[]).filter((d): d is string => typeof d === "string" && ULID_RE.test(d));
    if (keep.length !== (body.relates_to as unknown[]).length) ambiguity.push("relates_to_contains_non_ulid");
    body.relates_to = keep;
  }
  if (!Array.isArray(body.tags)) body.tags = [];
  return body;
}

function simplePayload(rec: LegacyRecord, required: string[], ambiguity: string[]): Record<string, unknown> {
  const body = omit(rec.body, ["id", "provenance"]);
  for (const key of required) {
    if (typeof body[key] !== "string" || (body[key] as string).length === 0) {
      ambiguity.push(`${key}_not_recorded`);
      body[key] = NOT_RECORDED;
    }
  }
  return body;
}

const RECORD_TYPE_OF: Record<LegacyRecord["kind"], string> = {
  decision: "decision",
  post: "post",
  entity: "entity",
  relation: "relation",
  handoff: "handoff",
};

function payloadFor(rec: LegacyRecord, ambiguity: string[]): Record<string, unknown> {
  switch (rec.kind) {
    case "decision":
      return decisionPayload(rec, ambiguity);
    case "post":
      return postPayload(rec, ambiguity);
    case "entity":
      return simplePayload(rec, ["name", "type"], ambiguity);
    case "relation":
      return simplePayload(rec, ["source", "target", "type"], ambiguity);
    case "handoff":
      return simplePayload(rec, ["summary", "source_agent"], ambiguity);
  }
}

// ------------------------------------------------------------ event builders

interface BuildCtx {
  identity: MigrationIdentity;
  /** Every legacy id that has (or will have) a created event. */
  known: Set<string>;
}

function envelope(fields: Record<string, unknown>): Record<string, unknown> {
  const ev = { v: ENVELOPE_V, ...fields };
  (ev as Record<string, unknown>).digest = computeEventDigest(ev as Record<string, unknown>);
  return ev;
}

function legacyBlock(ambiguity: string[], legacyStatus?: string): Record<string, unknown> {
  return {
    derived_from_legacy_snapshot: true,
    ...(ambiguity.length > 0 ? { legacy_ambiguity: [...new Set(ambiguity)].sort() } : {}),
    ...(legacyStatus ? { legacy_status: legacyStatus } : {}),
  };
}

function timestampOf(body: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
}

/** The `created` event for one legacy record. Its id IS the legacy id (§10.3). */
export function createdEventFor(rec: LegacyRecord, ctx: BuildCtx, overrideId?: string): Record<string, unknown> {
  const ambiguity = [...rec.ambiguity];
  const payload = payloadFor(rec, ambiguity);
  const scope = scopeFromLegacy(ctx.identity.repo_id, rec.body.scope, ambiguity);
  const src = sourceFromLegacy(rec.body);
  const id = overrideId ?? rec.legacy_id;
  const assertedActor = typeof rec.body.agent_id === "string" ? rec.body.agent_id : typeof rec.body.source_agent === "string" ? (rec.body.source_agent as string) : undefined;
  return envelope({
    id,
    kind: "created",
    record: { type: RECORD_TYPE_OF[rec.kind], id },
    scope,
    producer: {
      principal: ctx.identity.principal,
      kind: "agent",
      host: ctx.identity.host,
      // The legacy agent_id is a caller-supplied label, recorded and never
      // authoritative (ADR §1.2). Absent stays absent (C21 A-REC-05).
      ...(assertedActor ? { asserted_actor: assertedActor } : {}),
    },
    ...(src ? { source: src } : {}),
    parents: [],
    evidence_class: "legacy_unverified",
    occurred_at: timestampOf(rec.body, "timestamp", "created_at"),
    payload,
    attachments: [
      {
        sha256: rec.sha256,
        bytes: rec.raw.length,
        media_type: "application/json",
        source_kind: "legacy_record",
        source_uri: `legacy:${rec.file}${rec.anchor ? `#${rec.anchor}` : ""}`,
        encoding: "utf-8",
      },
    ],
    legacy: legacyBlock(ambiguity, typeof rec.body.status === "string" ? (rec.body.status as string) : undefined),
  });
}

interface DerivedSpec {
  kind: string;
  recordType: string;
  targetId: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  ambiguity: string[];
  legacyStatus?: string;
  /**
   * A legacy value that names a PERSON or an agent rather than a record —
   * 1.x `overridden_by`/`superseded_by` is an actor label at least as often
   * as an id. Lifecycle payloads are strict, so the label rides
   * `producer.asserted_actor` (recorded, displayed, never authoritative) and
   * is repeated inside the ambiguity string, so it survives in both the
   * structured field and the audit trail.
   */
  assertedActor?: string;
}

function derivedEvent(spec: DerivedSpec, ctx: BuildCtx, parents: string[]): Record<string, unknown> {
  const id = derivedId(`${spec.targetId}:${spec.kind}:${JSON.stringify(spec.payload)}`);
  return envelope({
    id,
    kind: spec.kind,
    record: { type: spec.recordType, id: spec.targetId },
    // Derived lifecycle is authored repo-wide: it is the MIGRATOR's
    // reconstruction of a status field, not a scoped authority claim, and a
    // repo-wide author scope governs every target scope without inventing one.
    scope: { repo: ctx.identity.repo_id },
    producer: {
      principal: ctx.identity.principal,
      kind: "agent",
      host: ctx.identity.host,
      ...(spec.assertedActor ? { asserted_actor: spec.assertedActor } : {}),
    },
    parents,
    evidence_class: "legacy_unverified",
    occurred_at: spec.occurred_at,
    payload: spec.payload,
    legacy: legacyBlock(spec.ambiguity, spec.legacyStatus),
  });
}

/**
 * Lifecycle events reconstructed from a legacy record's status fields
 * (ADR §10.2). Each is parented on the one before it, so the causal order the
 * reducer replays is the order the legacy store implies.
 */
export function derivedEventsFor(
  rec: LegacyRecord,
  ctx: BuildCtx,
  /** legacy id → the id of the record that declares `supersedes: <this id>`. */
  supersederOf: Map<string, string>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const recordType = RECORD_TYPE_OF[rec.kind];
  const body = rec.body;
  const chain = (): string[] => [out.length > 0 ? (out[out.length - 1] as { id: string }).id : rec.legacy_id];
  const push = (spec: Omit<DerivedSpec, "recordType" | "targetId">, extraParents: string[] = []): void => {
    out.push(derivedEvent({ ...spec, recordType, targetId: rec.legacy_id }, ctx, [...chain(), ...extraParents]));
  };

  // promoted_by/promoted_at → the record was provisional and was ratified.
  if (typeof body.promoted_by === "string" || typeof body.promoted_at === "string") {
    push({
      kind: "promoted",
      payload: { target: rec.legacy_id },
      occurred_at: timestampOf(body, "promoted_at", "timestamp"),
      ambiguity: typeof body.promoted_at === "string" ? [] : ["promoted_at_not_recorded"],
    });
  }

  // amendments[] → one `amended` each, in recorded order (append-only trail).
  for (const am of (body.amendments as Array<Record<string, unknown>> | undefined) ?? []) {
    push({
      kind: "amended",
      payload: {
        target: rec.legacy_id,
        add_affected_files: ((am.added_files as string[]) ?? []).filter((f) => typeof f === "string" && f.length > 0),
        add_affected_symbols: ((am.added_symbols as string[]) ?? []).filter((f) => typeof f === "string" && f.length > 0),
        reason: typeof am.reason === "string" && am.reason.length > 0 ? am.reason : NOT_RECORDED,
      },
      occurred_at: timestampOf(am, "amended_at"),
      ambiguity: typeof am.reason === "string" && am.reason.length > 0 ? [] : ["amendment_reason_not_recorded"],
    });
  }

  const status = typeof body.status === "string" ? body.status : "";

  // The status the record held BEFORE it was archived, so `archived_from` is
  // derived from the event chain rather than guessed (ADR §4.4).
  const terminal = status === "archived" ? (typeof body.archived_from === "string" ? body.archived_from : "") : status;
  const archivedAmbiguity: string[] = [];
  if (status === "archived" && typeof body.archived_from !== "string") archivedAmbiguity.push("archived_without_archived_from");

  if (terminal === "superseded") {
    const declared = typeof body.superseded_by === "string" && body.superseded_by.length > 0 ? body.superseded_by : undefined;
    const recovered = declared ?? supersederOf.get(rec.legacy_id);
    const by = recovered && ctx.known.has(recovered) ? recovered : undefined;
    // "absent" and "present but not a record id" are DIFFERENT facts. 1.x
    // wrote an actor label into these fields as often as a record id
    // (decisions.ts: `overridden_by: overriddenBy ?? "human"`), so claiming
    // the field was missing would invent provenance in the audit trail.
    const unresolved = by === undefined && declared !== undefined ? declared : undefined;
    if (by) {
      push(
        {
          kind: "superseded",
          payload: { target: rec.legacy_id, by, reason: "legacy status: superseded" },
          occurred_at: timestampOf(body, "timestamp"),
          ambiguity: declared ? [] : ["superseded_by_recovered_from_supersedes_pointer"],
        },
        [by],
      );
    } else {
      // A retirement with no recoverable successor. `superseded` requires
      // `by`, so the applicable state is carried by `overridden` (the only
      // retirement kind whose successor is optional) and the original word
      // survives verbatim in `legacy.legacy_status`. Proposed contract diff:
      // make `superseded.by` optional so this reads as what it is.
      push({
        kind: "overridden",
        payload: {
          target: rec.legacy_id,
          reason: unresolved
            ? `legacy status: superseded by ${unresolved}, which is not a record in this store`
            : "legacy status: superseded, successor not recorded",
        },
        occurred_at: timestampOf(body, "timestamp"),
        ambiguity: [
          unresolved ? `superseded_by_not_a_record_id:${unresolved}` : "superseded_without_superseded_by",
          "represented_as_overridden",
        ],
        legacyStatus: "superseded",
        ...(unresolved ? { assertedActor: unresolved } : {}),
      });
    }
  } else if (terminal === "overridden") {
    const declaredBy = typeof body.overridden_by === "string" && body.overridden_by.length > 0 ? (body.overridden_by as string) : undefined;
    const by = declaredBy !== undefined && ctx.known.has(declaredBy) ? declaredBy : undefined;
    // 1.x/2.x `overridden_by` is an ACTOR label at least as often as a record
    // id (src/engine/decisions.ts writes `overriddenBy ?? "human"`). Saying
    // "overridden_without_overridden_by" about a record that plainly had one
    // is invented provenance; keep the value and name what it actually is.
    const unresolvedBy = by === undefined ? declaredBy : undefined;
    const reason = typeof body.override_reason === "string" && body.override_reason.length > 0 ? (body.override_reason as string) : `legacy status: overridden, reason ${NOT_RECORDED}`;
    push(
      {
        kind: "overridden",
        payload: {
          target: rec.legacy_id,
          ...(by ? { replacement: by } : {}),
          reason,
        },
        occurred_at: timestampOf(body, "timestamp"),
        ambiguity: [
          ...(by ? [] : unresolvedBy ? [`overridden_by_not_a_record_id:${unresolvedBy}`] : ["overridden_without_overridden_by"]),
          ...(typeof body.override_reason === "string" && body.override_reason.length > 0 ? [] : ["override_reason_not_recorded"]),
        ],
        ...(unresolvedBy ? { assertedActor: unresolvedBy } : {}),
      },
      by ? [by] : [],
    );
  }

  if (status === "archived") {
    push({
      kind: "archived",
      payload: { target: rec.legacy_id, reason: "legacy status: archived" },
      occurred_at: timestampOf(body, "timestamp"),
      ambiguity: archivedAmbiguity,
    });
  }

  // Posts: explicit resolution, and the 1.x archiver's own archive/ stream.
  if (rec.kind === "post") {
    if (body.status === "resolved") {
      push({
        kind: "resolved",
        payload: { target: rec.legacy_id, ...(typeof body.resolution_note === "string" ? { note: body.resolution_note } : {}) },
        occurred_at: timestampOf(body, "resolved_at", "timestamp"),
        ambiguity: typeof body.resolved_at === "string" ? [] : ["resolved_at_not_recorded"],
      });
    }
    if (rec.ambiguity.includes("archived_by_legacy_archiver")) {
      push({
        kind: "archived",
        payload: { target: rec.legacy_id, reason: "swept into archive/ by the legacy archiver" },
        occurred_at: timestampOf(body, "timestamp"),
        ambiguity: [],
      });
    }
  }

  if (rec.kind === "handoff" && typeof body.acknowledged_by === "string") {
    push({
      kind: "acknowledged",
      payload: { target: rec.legacy_id },
      occurred_at: timestampOf(body, "acknowledged_at", "created_at"),
      ambiguity: typeof body.acknowledged_at === "string" ? [] : ["acknowledged_at_not_recorded"],
    });
  }

  return out;
}

// -------------------------------------------------------------------- steps

/**
 * `prior` is the manifest a previous run froze. File anchors are FIRST-WINS:
 * "frozen" has to mean frozen, and on a store that was 2.x a rollback writes
 * its 2.x view over the original legacy files — so a manifest rebuilt from
 * current disk would replace the pre-migration hash with the view's and the
 * byte anchor every C21 assertion compares against would be gone. Ids,
 * relationships and defect lists are rebuilt each run (they describe what is
 * there now); the byte anchors only ever grow.
 */
function buildManifest(scan: LegacyScan, prior: LegacyManifest | null): LegacyManifest {
  const files: Record<string, ManifestFileEntry> = { ...(prior?.files ?? {}) };
  for (const f of scan.files) {
    if (files[f.rel] !== undefined) continue; // already frozen by an earlier run
    files[f.rel] = { sha256: f.sha256, bytes: f.bytes };
  }
  const ids: LegacyManifest["ids"] = {};
  for (const r of [...scan.records, ...scan.rivals]) {
    ids[r.legacy_id === undefined ? "" : `${r.legacy_id}@${r.file}`] = {
      kind: r.kind,
      file: r.file,
      sha256: r.sha256,
      ...(r.anchor ? { anchor: r.anchor } : {}),
    };
  }
  return {
    format: 3,
    generated_from: path.basename(scan.twiningDir),
    layouts: scan.layouts,
    files,
    ids,
    relationships: scan.relationships,
    damaged: scan.damaged,
    conflicts: scan.conflicts,
  };
}

function findingsFrom(scan: LegacyScan): MigrateV3Report["findings"] {
  const out: MigrateV3Report["findings"] = [];
  for (const d of scan.damaged) {
    out.push({ kind: `damaged:${d.reason}`, subject: `${d.file}${d.anchor ? `#${d.anchor}` : ""}`, detail: `${d.bytes} bytes retained, content not reconstructed` });
  }
  for (const c of scan.conflicts) {
    out.push({ kind: "conflict:duplicate_declared_id", subject: c.legacy_id, detail: `declared by ${[c.primary, ...c.rivals].join(", ")} with different bytes` });
  }
  for (const r of scan.records) {
    for (const a of r.ambiguity) out.push({ kind: `ambiguity:${a.split(":")[0]}`, subject: r.legacy_id, detail: a });
  }
  return out;
}

/** Retain the bytes of everything that could not become a record. */
function quarantineDamaged(twiningDir: string, scan: LegacyScan): void {
  if (scan.damaged.length === 0) return;
  ensureDir(quarantineDir(twiningDir));
  for (const d of scan.damaged) {
    const abs = path.join(twiningDir, d.file);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      continue;
    }
    // JSONL damage keeps the whole stream; a per-file damage keeps the file.
    // The BUFFER, never a decoded string: a quarantined blob is retained so
    // its recoverable bytes survive, and a UTF-8 round trip would rewrite the
    // very bytes the quarantine exists to preserve.
    atomicWriteFileSync(path.join(quarantineDir(twiningDir), `${d.sha256}.bytes`), bytes);
    writeJson(path.join(quarantineDir(twiningDir), `${d.sha256}.json`), {
      file: d.file,
      anchor: d.anchor,
      reason: d.reason,
      sha256: d.sha256,
      bytes: d.bytes,
      note: "recoverable bytes retained verbatim; meaning was NOT reconstructed",
    });
  }
}

/**
 * Content-addressed, never rewritten. A failure here is REPORTED and left for
 * verification to catch, not thrown: an I/O problem on one attachment must not
 * abort the run half way through the event step with a raw errno, because that
 * leaves a store whose state nobody described. Verification then fails on the
 * missing attachment and finalize never runs, so config.version is unchanged.
 */
function writeAttachment(twiningDir: string, sha: string, bytes: Buffer, findings: MigrateV3Report["findings"]): void {
  const file = attachmentPath(twiningDir, sha);
  try {
    if (fs.existsSync(file)) return;
    ensureDir(path.dirname(file));
    // Content-addressed: the file NAME is the sha256 of these bytes, so they
    // are written as bytes. Decoding to UTF-8 first would map every invalid
    // sequence to U+FFFD and the blob would stop hashing to its own name.
    atomicWriteFileSync(file, bytes);
  } catch (err) {
    findings.push({ kind: "attachment:unwritable", subject: sha, detail: err instanceof Error ? err.message : String(err) });
  }
}

const RECORDS_FROZEN = `# records/ is FROZEN

This project migrated to the Twining v3 event store (\`config.version: 3\`).

\`.twining/records/\` is the **2.x view** of the data and is no longer written
by the server. The authoritative history is \`.twining/events/\` plus the
content-addressed bytes under \`.twining/attachments/\`; \`.twining/store/twining.db\`
is a derived cache that can be deleted and rebuilt at any time.

Editing a file under \`records/\` has no effect on the v3 projection UNTIL a
\`twining rollback --to 2\` followed by \`twining migrate --to 3\`, which records
the changed file as a new legacy event (post-rollback writes are preserved).

Nothing here was deleted by the migration: the legacy bytes are also retained
verbatim as attachments, and \`legacy/manifest.json\` carries their hashes.
`;

// ---------------------------------------------------------------- the driver

export async function migrateToV3(opts: MigrateV3Options): Promise<MigrateV3Report> {
  const twiningDir = path.join(opts.projectRoot, ".twining");
  if (!fs.existsSync(twiningDir)) throw new Error(`no .twining/ directory at ${twiningDir} — nothing to migrate`);

  const prior = readMigrationState(twiningDir);
  const identity = resolveIdentity(twiningDir, prior);
  const now = new Date().toISOString();
  const notes: string[] = [];

  // ---- step 1: manifest -----------------------------------------------
  const viewManifest = readViewManifest(twiningDir);
  const scan = scanLegacyStore(twiningDir, { viewManifest });
  const manifest = buildManifest(scan, readManifest(twiningDir));
  const findings = findingsFrom(scan);

  const state: MigrationState = {
    target_format: 3,
    status: "incomplete",
    completed_steps: [],
    identity,
    started_at: prior?.started_at ?? now,
    updated_at: now,
    counts: {},
  };

  if (opts.dryRun) {
    // §10.1: the dry run writes the manifest and NOTHING else — no events, no
    // attachments, no config change, and the legacy bytes are untouched.
    writeJson(manifestPath(twiningDir), manifest);
    return {
      ok: true,
      dry_run: true,
      state: { ...state, completed_steps: ["manifest"] },
      manifest_path: manifestPath(twiningDir),
      counts: {
        legacy_files: scan.files.length,
        legacy_records: scan.records.length,
        created_events: 0,
        derived_events: 0,
        rivals: scan.rivals.length,
        damaged: scan.damaged.length,
        conflicts: scan.conflicts.length,
        post_rollback_writes: 0,
        duplicate_suppressed: 0,
      },
      findings,
      verification: null,
      notes: [...notes, "dry run: legacy/manifest.json written; no events, no config change"],
    };
  }

  writeJson(manifestPath(twiningDir), manifest);
  writeJson(statePath(twiningDir), state);
  quarantineDamaged(twiningDir, scan);
  state.completed_steps.push("manifest");
  opts.hooks?.afterStep?.("manifest");

  // ---- step 2: events --------------------------------------------------
  const store = new EventStore({ twiningDir, now: () => now });
  const idMap: Record<string, IdMapEntry> = readIdMap(twiningDir);
  let created = 0;
  let derived = 0;
  let duplicates = 0;
  let postRollbackWrites = 0;
  // Every record a post-rollback successor has ever retired, from the durable
  // id map — not just the ones this run created.
  const postRollbackTargets = new Set<string>(
    Object.values(idMap)
      .filter((e) => e.origin === "post_rollback" && typeof e.rival_of === "string")
      .map((e) => e.rival_of as string),
  );

  try {
    // NOTE (measured, reported to lane 02b / the lead): the migration seeds NO
    // membership. Admission default-allows `write` only while no policy has
    // been admitted, so a migrated store is rebuild-stable on its own — but a
    // membership added LATER that does not name the migrator causes rebuild()
    // to re-admit some migration events against that newer policy and reject
    // them as `unauthorized`. Seeding a policy here was tried and rejected: any
    // seeded membership can only be changed by a principal it grants `rule`, so
    // it locks the store's policy to the migrator forever. The durable fix is
    // for admission to stop re-evaluating capability retroactively, which is
    // lane 02b's seam, not this one.
    const ctx: BuildCtx = { identity, known: new Set(scan.records.map((r) => r.legacy_id)) };

    // Reverse index: who declares `supersedes: X`? Salvages the missing
    // back-link that 1.24.0 never wrote (ADR §10.2 relationship fields).
    const supersederOf = new Map<string, string>();
    for (const r of scan.records) {
      const sup = r.body.supersedes;
      if (typeof sup === "string" && sup.length > 0) supersederOf.set(sup, r.legacy_id);
    }

    const appendOne = async (ev: Record<string, unknown>): Promise<boolean> => {
      const outcome = await store.append(ev, "migration");
      if ("ok" in outcome && outcome.ok === false) {
        findings.push({ kind: "rejected:schema", subject: String(ev.id), detail: outcome.validation.ok ? "unknown" : outcome.validation.message });
        return false;
      }
      const res = outcome as { duplicate: boolean };
      if (res.duplicate) duplicates += 1;
      opts.hooks?.afterEvent?.(created + derived, String(ev.id));
      return true;
    };

    // 2a. created events, ids preserved.
    for (const rec of scan.records) {
      const ev = createdEventFor(rec, ctx);
      if (await appendOne(ev)) {
        created += 1;
        writeAttachment(twiningDir, rec.sha256, rec.raw, findings);
        idMap[rec.legacy_id] = { created: rec.legacy_id, kind: rec.kind, derived: idMap[rec.legacy_id]?.derived ?? [] };
      }
    }

    // 2b. rival bodies for a conflicting declared id: BOTH byte streams become
    //     records, and the pair is contested in both directions so neither is
    //     a member of the applicable view (C21 A-REC-09).
    for (const rival of scan.rivals) {
      const rivalId = derivedId(`${rival.legacy_id}:rival:${rival.sha256}`);
      const ev = createdEventFor({ ...rival, ambiguity: [...rival.ambiguity, `duplicate_declared_id:${rival.legacy_id}`] }, ctx, rivalId);
      if (!(await appendOne(ev))) continue;
      created += 1;
      writeAttachment(twiningDir, rival.sha256, rival.raw, findings);
      idMap[rivalId] = { created: rivalId, kind: rival.kind, derived: [], rival_of: rival.legacy_id, origin: "duplicate_rival" };
      const recordType = RECORD_TYPE_OF[rival.kind];
      // Both directions get the `contested` ANNOTATION, so the conflict is
      // visible from either body (ADR §4.3 rule 1's annotation, not a status
      // change — the reducer deliberately does not retire a contested target).
      const pair: Array<[string, string]> = [
        [rival.legacy_id, rivalId],
        [rivalId, rival.legacy_id],
      ];
      for (const [target, by] of pair) {
        const contested = derivedEvent(
          {
            kind: "contested",
            recordType,
            targetId: target,
            payload: { target, by, reason: `two legacy files declare id ${rival.legacy_id} with different bytes` },
            occurred_at: timestampOf(rival.body, "timestamp", "created_at"),
            ambiguity: ["duplicate_declared_id"],
          },
          ctx,
          [target, by],
        );
        if (await appendOne(contested)) derived += 1;
      }
      // …and the RIVAL body is archived: retained and inspectable with
      // include_archived, never served by default, and explicitly NOT revoked
      // (ADR §4.4). That is how "both byte streams retained, neither silently
      // admitted as the value" is expressible without inventing a resolution
      // the legacy store never recorded.
      const hide = derivedEvent(
        {
          kind: "archived",
          recordType,
          targetId: rivalId,
          payload: { target: rivalId, reason: `duplicate declared id ${rival.legacy_id}: retained for inspection, not served` },
          occurred_at: timestampOf(rival.body, "timestamp", "created_at"),
          ambiguity: ["duplicate_declared_id"],
        },
        ctx,
        [rivalId],
      );
      if (await appendOne(hide)) derived += 1;
    }

    // 2c. derived lifecycle.
    for (const rec of scan.records) {
      const events = derivedEventsFor(rec, ctx, supersederOf);
      const entry = idMap[rec.legacy_id];
      const list: Array<{ id: string; kind: string }> = [];
      for (const ev of events) {
        if (await appendOne(ev)) {
          derived += 1;
          list.push({ id: String(ev.id), kind: String(ev.kind) });
        }
      }
      if (entry) entry.derived = list;
    }

    // 2d. post-rollback writes. A file under records/ that the LAST ROLLBACK
    //     generated is a view of a record that already exists as events, so an
    //     unchanged view is a no-op. A CHANGED one is a real write made while
    //     rolled back, and the event log is immutable — so the new body is
    //     recorded as its own record and the original is superseded by it
    //     (§10.8: post-rollback writes are preserved). A file under records/
    //     that the rollback did NOT write is a brand-new record and was
    //     already handled as an ordinary legacy record above.
    for (const view of scan.views) {
      const rel = view.file;
      if (viewManifest[rel] === view.sha256) continue; // untouched view
      const successorId = derivedId(`${view.legacy_id}:post-rollback:${view.sha256}`);
      if (idMap[successorId]) continue; // already preserved by an earlier run
      const successor = createdEventFor(
        { ...view, ambiguity: [...view.ambiguity, "post_rollback_write_recorded_as_successor"] },
        ctx,
        successorId,
      );
      if (!(await appendOne(successor))) continue;
      created += 1;
      postRollbackWrites += 1;
      writeAttachment(twiningDir, view.sha256, view.raw, findings);
      idMap[successorId] = { created: successorId, kind: view.kind, derived: [], rival_of: view.legacy_id, origin: "post_rollback" };
      if (ctx.known.has(view.legacy_id)) {
        const sup = derivedEvent(
          {
            kind: "superseded",
            recordType: RECORD_TYPE_OF[view.kind],
            targetId: view.legacy_id,
            payload: { target: view.legacy_id, by: successorId, reason: "records/ file changed while rolled back" },
            occurred_at: timestampOf(view.body, "timestamp", "created_at"),
            ambiguity: ["post_rollback_write_recorded_as_successor"],
          },
          ctx,
          [view.legacy_id, successorId],
        );
        if (await appendOne(sup)) derived += 1;
        postRollbackTargets.add(view.legacy_id);
      }
    }

    state.completed_steps.push("events");
    opts.hooks?.afterStep?.("events");

    // ---- step 3: id map ------------------------------------------------
    writeJson(idMapPath(twiningDir), idMap);
    state.completed_steps.push("idmap");
    opts.hooks?.afterStep?.("idmap");

    // ---- step 4: verify ------------------------------------------------
    await store.admit();
    await store.project();
    const verification = await verifyV3(store, scan, manifest, twiningDir, postRollbackTargets);
    state.completed_steps.push("verify");
    opts.hooks?.afterStep?.("verify");

    state.counts = {
      legacy_files: scan.files.length,
      legacy_records: scan.records.length,
      created_events: created,
      derived_events: derived,
      damaged: scan.damaged.length,
      conflicts: scan.conflicts.length,
    };

    if (!verification.ok) {
      state.updated_at = new Date().toISOString();
      writeJson(statePath(twiningDir), state);
      return {
        ok: false,
        dry_run: false,
        state,
        manifest_path: manifestPath(twiningDir),
        counts: {
          legacy_files: scan.files.length,
          legacy_records: scan.records.length,
          created_events: created,
          derived_events: derived,
          rivals: scan.rivals.length,
          damaged: scan.damaged.length,
          conflicts: scan.conflicts.length,
          post_rollback_writes: postRollbackWrites,
          duplicate_suppressed: duplicates,
        },
        findings,
        verification,
        notes: [...notes, "VERIFICATION FAILED — config.version was NOT changed; nothing is frozen"],
      };
    }

    // ---- step 5: finalize ----------------------------------------------
    // An existing descriptor (`identity init` ran first, or this is a rerun)
    // is EXTENDED, never replaced: every repo id it declares survives (a
    // shared store's second checkout already cites its own), its created_at
    // stands, and migrated_from keeps the first run's observation — a rerun
    // sees records/RECORDS-FROZEN.md and would otherwise re-read a v1 store
    // as v2. identity.store_id / repo_id are already the descriptor's own
    // (resolveIdentity adopted them), so the ids events cite never move.
    const existing = readStoreJson(twiningDir);
    const declaredRepoIds = Array.isArray(existing?.repo_ids) ? existing.repo_ids.filter(nonEmptyString) : [];
    writeJson(storeJsonPath(twiningDir), {
      store_id: identity.store_id,
      repo_id: identity.repo_id,
      repo_ids: [identity.repo_id, ...declaredRepoIds.filter((id) => id !== identity.repo_id)],
      format: STORE_FORMAT_VERSION,
      created_at: nonEmptyString(existing?.created_at) ? existing.created_at : state.started_at,
      migrated_from: typeof existing?.migrated_from === "number" ? existing.migrated_from : scan.layouts.includes("v2") ? 2 : 1,
    });
    ensureDir(path.join(twiningDir, "records"));
    atomicWriteFileSync(path.join(twiningDir, "records", "RECORDS-FROZEN.md"), RECORDS_FROZEN);
    setStorageBackend(twiningDir, "sqlite", { formatVersion: 3 });
    ensureV3Gitignore(twiningDir);

    state.status = "complete";
    state.completed_steps.push("finalize");
    delete state.rolled_back_at;
    state.updated_at = new Date().toISOString();
    writeJson(statePath(twiningDir), state);
    opts.hooks?.afterStep?.("finalize");

    return {
      ok: true,
      dry_run: false,
      state,
      manifest_path: manifestPath(twiningDir),
      counts: {
        legacy_files: scan.files.length,
        legacy_records: scan.records.length,
        created_events: created,
        derived_events: derived,
        rivals: scan.rivals.length,
        damaged: scan.damaged.length,
        conflicts: scan.conflicts.length,
        post_rollback_writes: postRollbackWrites,
        duplicate_suppressed: duplicates,
      },
      findings,
      verification,
      notes: [
        ...notes,
        "legacy files were not modified — they remain their own backup",
        "records/ is frozen (records/RECORDS-FROZEN.md); the authority is events/ + attachments/",
      ],
    };
  } finally {
    store.close();
  }
}

function ensureV3Gitignore(twiningDir: string): void {
  const file = path.join(twiningDir, ".gitignore");
  const wanted = ["store/", "twining.db", "twining.db-wal", "twining.db-shm", "legacy/quarantine/"];
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const present = new Set(raw.split("\n").map((l) => l.trim()));
  const add = wanted.filter((l) => !present.has(l));
  if (add.length === 0) return;
  const base = raw.length > 0 && !raw.endsWith("\n") ? `${raw}\n` : raw;
  atomicWriteFileSync(file, base + add.join("\n") + "\n");
}

// ------------------------------------------------------------- verification

/** Legacy status → the status the v3 projection must show. */
export function expectedStatusFor(rec: LegacyRecord): { status: string[]; archived: boolean } {
  const s = typeof rec.body.status === "string" ? rec.body.status : "";
  if (rec.kind === "post") {
    return { status: s === "resolved" ? ["resolved"] : ["open"], archived: rec.ambiguity.includes("archived_by_legacy_archiver") };
  }
  if (rec.kind === "handoff") {
    return { status: typeof rec.body.acknowledged_by === "string" ? ["acknowledged"] : ["pending"], archived: false };
  }
  if (rec.kind !== "decision") return { status: ["active"], archived: false };
  if (s === "archived") {
    const from = typeof rec.body.archived_from === "string" ? rec.body.archived_from : "active";
    return { status: from === "superseded" ? ["superseded", "overridden"] : [from], archived: true };
  }
  if (s === "superseded") return { status: ["superseded", "overridden"], archived: false };
  if (s === "overridden") return { status: ["overridden"], archived: false };
  if (s === "provisional") return { status: ["provisional"], archived: false };
  return { status: ["active"], archived: false };
}

export async function verifyV3(
  store: EventStore,
  scan: LegacyScan,
  manifest: LegacyManifest,
  twiningDir: string,
  /**
   * Records this run retired because a POST-ROLLBACK write superseded them.
   * Their legacy file still says `active`; the projection correctly says
   * `superseded`. Checking the file against the projection there would fail
   * the run for doing exactly what §10.8 requires.
   */
  postRollbackSuperseded: ReadonlySet<string> = new Set(),
): Promise<VerificationResult> {
  const missing: string[] = [];
  const statusMismatched: VerificationResult["status_mismatched"] = [];
  const relationshipsMissing: VerificationResult["relationships_missing"] = [];
  const attachmentMismatched: string[] = [];
  const conflicted = new Set(scan.conflicts.map((c) => c.legacy_id));

  for (const rec of scan.records) {
    const projected = await store.get(rec.legacy_id);
    if (!projected) {
      missing.push(rec.legacy_id);
      continue;
    }
    // A record whose id two files declare is deliberately NOT in the
    // applicable view; its status is the contested annotation.
    if (!conflicted.has(rec.legacy_id) && !postRollbackSuperseded.has(rec.legacy_id)) {
      const expected = expectedStatusFor(rec);
      if (!expected.status.includes(projected.status)) {
        statusMismatched.push({ id: rec.legacy_id, expected: expected.status.join("|"), actual: projected.status });
      }
      if (expected.archived !== projected.archived) {
        statusMismatched.push({ id: rec.legacy_id, expected: `archived=${expected.archived}`, actual: `archived=${projected.archived}` });
      }
    }

    // Relationships: subset containment (the manifest's set ⊆ the projection's).
    const rel = manifest.relationships[rec.legacy_id];
    if (rel) {
      const has = (field: string, value: string): boolean => {
        switch (field) {
          case "superseded_by":
            return projected.superseded_by.includes(value) || projected.body.superseded_by === value || projected.status === "overridden";
          case "overridden_by":
            return projected.overridden_by === value || projected.status === "overridden";
          case "supersedes":
            return true; // asserted on the OTHER record's supersession event
          case "archived_from":
            return projected.archived_from === value || projected.archived;
          case "depends_on":
          case "relates_to":
            return ((projected.body[field] as string[] | undefined) ?? []).includes(value);
          case "source":
          case "target":
            return projected.body[field] === value;
          default:
            return true;
        }
      };
      for (const [field, value] of Object.entries(rel)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (typeof v !== "string") continue;
          // A pointer at a record the legacy store never held cannot be
          // reconstructed; the manifest keeps it, the projection cannot.
          if ((field === "superseded_by" || field === "overridden_by" || field === "supersedes" || field === "depends_on") && !scan.records.some((r) => r.legacy_id === v)) continue;
          if (!has(field, v)) relationshipsMissing.push({ id: rec.legacy_id, field, value: v });
        }
      }
    }
  }

  // Attachment bytes: every migrated record's stored attachment must hash to
  // the frozen manifest value (C21 A-REC-01 — read from the STORED file, not
  // from a value re-derived at read time).
  let attachments = 0;
  for (const rec of scan.records) {
    const file = attachmentPath(twiningDir, rec.sha256);
    if (!fs.existsSync(file)) {
      attachmentMismatched.push(`${rec.legacy_id}:absent`);
      continue;
    }
    attachments += 1;
    if (sha256Of(fs.readFileSync(file)) !== rec.sha256) attachmentMismatched.push(`${rec.legacy_id}:hash`);
  }

  return {
    ok: missing.length === 0 && statusMismatched.length === 0 && relationshipsMissing.length === 0 && attachmentMismatched.length === 0,
    records_checked: scan.records.length,
    attachments_checked: attachments,
    missing,
    status_mismatched: statusMismatched,
    relationships_missing: relationshipsMissing,
    attachment_mismatched: attachmentMismatched,
  };
}

// ------------------------------------------------------------------- status

export interface MigrateStatus {
  format: number;
  /** `not_started` | `incomplete` | `complete` | `rolled_back`. */
  migration: "not_started" | "incomplete" | "complete" | "rolled_back";
  completed_steps: MigrationStep[];
  remaining_steps: MigrationStep[];
  store_id: string | null;
  repo_id: string | null;
  events: number;
  attachments: number;
  legacy_records: number;
  manifest_present: boolean;
  id_map_entries: number;
  records_frozen: boolean;
  rolled_back_at?: string;
}

/**
 * Count files under `dir`, tolerating an unreadable path. `migrateStatus` is a
 * READ that a tool loop calls to find out what state a store is in — including
 * a store that a failed run left in a strange shape — so it must never throw.
 * An unreadable subtree counts as zero and the caller still gets an answer.
 */
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

/** Read-only: what state is this store's migration in? */
export function migrateStatus(twiningDir: string): MigrateStatus {
  const state = readMigrationState(twiningDir);
  const manifest = readManifest(twiningDir);
  const idMap = readIdMap(twiningDir);
  let format = 1;
  let storeId: string | null = null;
  let repoId: string | null = null;
  const store = readStoreJson(twiningDir); // null: no store.json — pre-v3
  if (store) {
    storeId = typeof store.store_id === "string" ? store.store_id : null;
    repoId = declaredRepoId(store) ?? null;
    format = typeof store.format === "number" ? store.format : 1;
  }
  const completed = state?.completed_steps ?? [];
  return {
    format,
    migration: state === null ? "not_started" : state.status === "complete" ? "complete" : state.status === "rolled_back" ? "rolled_back" : "incomplete",
    completed_steps: completed,
    remaining_steps: MIGRATION_STEPS.filter((s) => !completed.includes(s)),
    store_id: storeId,
    repo_id: repoId,
    events: countFiles(path.join(twiningDir, "events"), ".json"),
    attachments: countFiles(path.join(twiningDir, "attachments")),
    legacy_records: manifest ? Object.keys(manifest.ids).length : 0,
    manifest_present: manifest !== null,
    id_map_entries: Object.keys(idMap).length,
    records_frozen: fs.existsSync(path.join(twiningDir, "records", "RECORDS-FROZEN.md")),
    ...(state?.rolled_back_at ? { rolled_back_at: state.rolled_back_at } : {}),
  };
}
