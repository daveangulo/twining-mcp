/**
 * Read a legacy (1.x file-backed or 2.x sqlite-era) store as BYTES.
 *
 * The v3 migration is byte-anchored (ADR §10.1, C21 A-REC-01): every legacy
 * file is hashed before anything is interpreted, and the interpretation is a
 * second, separately-reported step. Nothing in this module writes, and nothing
 * here ever reconstructs a value it could not read — a truncated or
 * conflict-marked file is retained with its recoverable bytes and reported,
 * never guessed into shape (C21 A-REC-11).
 *
 * It deliberately does NOT use the 1.x/2.x stores (DecisionStore et al.):
 * those are index-driven and would silently skip exactly the damaged and
 * desynced files this scan exists to find.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type LegacyKind = "decision" | "post" | "entity" | "relation" | "handoff";

/** One legacy file, as bytes. The manifest is built from these. */
export interface LegacyFileEntry {
  /** Path relative to .twining/ — POSIX separators, the manifest key. */
  rel: string;
  sha256: string;
  bytes: number;
}

/** One legacy record recovered from a file (or from one JSONL line). */
export interface LegacyRecord {
  legacy_id: string;
  kind: LegacyKind;
  /** Source file, relative to .twining/. */
  file: string;
  /** Anchor inside the file (JSONL line number), when the file holds many. */
  anchor?: string;
  /** Exact bytes that carried this record. */
  raw: Buffer;
  /** sha256 over `raw` — the attachment identity. */
  sha256: string;
  body: Record<string, unknown>;
  /** Everything the migration could not resolve, carried onto the event. */
  ambiguity: string[];
}

export type DamageReason =
  | "unparseable"
  | "conflict_markers"
  | "not_an_object"
  | "missing_id";

/** A file whose content could not be turned into a record. Never dropped. */
export interface DamagedFile {
  file: string;
  anchor?: string;
  reason: DamageReason;
  sha256: string;
  bytes: number;
  /** The readable prefix, verbatim and truncated for reporting only. */
  recoverable_prefix: string;
}

/** Two or more files declaring the same record id with different bytes. */
export interface ConflictPair {
  legacy_id: string;
  /** The file that keeps the legacy id; the others become rival records. */
  primary: string;
  rivals: string[];
}

export interface RelationshipFields {
  supersedes?: string;
  superseded_by?: string;
  overridden_by?: string;
  archived_from?: string;
  depends_on?: string[];
  relates_to?: string[];
  /** graph relations */
  source?: string;
  target?: string;
}

export interface ScanOptions {
  /**
   * rel path → sha256 of every file a `rollback --to 2` GENERATED. Those files
   * are 2.x VIEWS of records that already exist as events, not independent
   * legacy records: scanning them as records would make every migrated record
   * collide with its own view (the view's bytes necessarily differ from the
   * original's). They are returned in `views` instead, where the forward run
   * compares them against this map and preserves only what changed (§10.8).
   */
  viewManifest?: Record<string, string>;
}

export interface LegacyScan {
  twiningDir: string;
  /** Which layouts were found. A rolled-back store shows both. */
  layouts: Array<"v1" | "v2">;
  files: LegacyFileEntry[];
  records: LegacyRecord[];
  /** 2.x view files written by a rollback — compared, never re-created. */
  views: LegacyRecord[];
  /** Rival bodies for a conflicting declared id — retained, never current. */
  rivals: LegacyRecord[];
  damaged: DamagedFile[];
  conflicts: ConflictPair[];
  relationships: Record<string, RelationshipFields>;
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})/m;

export function sha256Of(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Directories and files that hold legacy records (ADR §10.1). */
const LEGACY_ROOTS = ["records", "decisions", "graph", "handoffs", "archive"];
const LEGACY_FILES = ["blackboard.jsonl"];

function walk(dir: string, prefix: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/** Every legacy file, relative to .twining/, in a stable order. */
export function legacyFilePaths(twiningDir: string): string[] {
  const out: string[] = [];
  for (const root of LEGACY_ROOTS) walk(path.join(twiningDir, root), root, out);
  for (const file of LEGACY_FILES) if (fs.existsSync(path.join(twiningDir, file))) out.push(file);
  return out.sort();
}

function relationshipsOf(kind: LegacyKind, body: Record<string, unknown>): RelationshipFields {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const arr = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : undefined;
  const out: RelationshipFields = {};
  const set = <K extends keyof RelationshipFields>(k: K, v: RelationshipFields[K]): void => {
    if (v !== undefined) out[k] = v;
  };
  set("supersedes", str(body.supersedes));
  set("superseded_by", str(body.superseded_by));
  set("overridden_by", str(body.overridden_by));
  set("archived_from", str(body.archived_from));
  set("depends_on", arr(body.depends_on));
  set("relates_to", arr(body.relates_to));
  if (kind === "relation") {
    set("source", str(body.source));
    set("target", str(body.target));
  }
  return out;
}

interface Candidate {
  kind: LegacyKind;
  file: string;
  anchor?: string;
  raw: Buffer;
  ambiguity: string[];
}

/**
 * Turn a byte blob into a record or a damage report. `expectedId` is the id the
 * FILENAME implies; a disagreement is recorded as ambiguity, never corrected.
 */
function interpret(c: Candidate, expectedId: string | undefined, damaged: DamagedFile[]): LegacyRecord | null {
  const text = c.raw.toString("utf8");
  const sha256 = sha256Of(c.raw);
  const report = (reason: DamageReason): null => {
    damaged.push({
      file: c.file,
      ...(c.anchor ? { anchor: c.anchor } : {}),
      reason,
      sha256,
      bytes: c.raw.length,
      recoverable_prefix: text.slice(0, 400),
    });
    return null;
  };
  if (CONFLICT_MARKER.test(text)) return report("conflict_markers");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return report("unparseable");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return report("not_an_object");
  const body = parsed as Record<string, unknown>;
  const legacyId = typeof body.id === "string" ? body.id : "";
  if (!legacyId) return report("missing_id");
  const ambiguity = [...c.ambiguity];
  // The PAYLOAD is a UTF-8 decode of the source, so a file that is not valid
  // UTF-8 loses information on the way into the body (U+FFFD). The attachment
  // keeps the true bytes; this names the fact that the two differ rather than
  // letting the body pass as a faithful copy.
  if (!Buffer.from(text, "utf8").equals(c.raw)) ambiguity.push("non_utf8_source_bytes");
  if (expectedId !== undefined && expectedId !== legacyId) {
    ambiguity.push(`id_filename_mismatch:filename=${expectedId}`);
  }
  return {
    legacy_id: legacyId,
    kind: c.kind,
    file: c.file,
    ...(c.anchor ? { anchor: c.anchor } : {}),
    raw: c.raw,
    sha256,
    body,
    ambiguity,
  };
}

function readCandidates(twiningDir: string, rel: string): Candidate[] {
  const abs = path.join(twiningDir, rel);
  const raw = fs.readFileSync(abs);
  const base = path.posix.basename(rel);

  // JSONL streams: one record per line, each its own byte range.
  if (rel === "blackboard.jsonl" || (rel.startsWith("archive/") && rel.endsWith(".jsonl"))) {
    const archived = rel.startsWith("archive/");
    const out: Candidate[] = [];
    const lines = raw.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trim() === "") return;
      out.push({
        kind: "post",
        file: rel,
        anchor: `line=${i + 1}`,
        raw: Buffer.from(line, "utf8"),
        ambiguity: archived ? ["archived_by_legacy_archiver"] : [],
      });
    });
    return out;
  }

  // Aggregate graph files (1.x): one JSON array per file.
  if (rel === "graph/entities.json" || rel === "graph/relations.json") {
    const kind: LegacyKind = rel.endsWith("entities.json") ? "entity" : "relation";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return [{ kind, file: rel, raw, ambiguity: [] }]; // interpret() reports the damage
    }
    if (!Array.isArray(parsed)) return [{ kind, file: rel, raw, ambiguity: [] }];
    return parsed.map((item, i) => ({
      kind,
      file: rel,
      anchor: `index=${i}`,
      raw: Buffer.from(JSON.stringify(item), "utf8"),
      ambiguity: [],
    }));
  }

  if (base === "index.json" || base === "index.jsonl") return []; // derived aggregates, not records
  if (rel === "records/RECORDS-FROZEN.md") return []; // the migration's own marker, not legacy data
  if (!rel.endsWith(".json")) return [];

  if (rel.startsWith("decisions/") || rel.startsWith("records/decisions/")) return [{ kind: "decision", file: rel, raw, ambiguity: [] }];
  if (rel.startsWith("records/posts/")) return [{ kind: "post", file: rel, raw, ambiguity: [] }];
  if (rel.startsWith("records/graph/entities/")) return [{ kind: "entity", file: rel, raw, ambiguity: [] }];
  if (rel.startsWith("records/graph/relations/")) return [{ kind: "relation", file: rel, raw, ambiguity: [] }];
  if (rel.startsWith("handoffs/") || rel.startsWith("records/handoffs/")) return [{ kind: "handoff", file: rel, raw, ambiguity: [] }];
  return [];
}

export function scanLegacyStore(twiningDir: string, opts: ScanOptions = {}): LegacyScan {
  const rels = legacyFilePaths(twiningDir);
  const files: LegacyFileEntry[] = [];
  const damaged: DamagedFile[] = [];
  const byId = new Map<string, LegacyRecord>();
  const rivals: LegacyRecord[] = [];
  const views: LegacyRecord[] = [];
  const conflicts = new Map<string, ConflictPair>();
  const viewManifest = opts.viewManifest ?? {};

  for (const rel of rels) {
    // The forward run's own marker is not legacy data and must not drift the
    // manifest on a second run (it would look like a legacy file appeared).
    if (rel === "records/RECORDS-FROZEN.md") continue;
    const raw = fs.readFileSync(path.join(twiningDir, rel));
    files.push({ rel, sha256: sha256Of(raw), bytes: raw.length });

    const isView = Object.prototype.hasOwnProperty.call(viewManifest, rel);

    for (const candidate of readCandidates(twiningDir, rel)) {
      const base = path.posix.basename(rel);
      const expectedId = candidate.anchor === undefined && base.endsWith(".json") ? base.slice(0, -".json".length) : undefined;
      const rec = interpret(candidate, expectedId, damaged);
      if (!rec) continue;

      if (isView) {
        views.push(rec);
        continue;
      }

      const prior = byId.get(rec.legacy_id);
      if (!prior) {
        byId.set(rec.legacy_id, rec);
        continue;
      }
      if (prior.sha256 === rec.sha256) continue; // the same bytes twice (both layouts present)

      // Two declarations of one id with different bytes. The file NAMED for
      // the id keeps it; the other is retained as a rival record so both byte
      // streams survive and neither can be silently admitted as the value.
      const primaryIsPrior = path.posix.basename(prior.file) === `${rec.legacy_id}.json` || prior.anchor !== undefined;
      const [keep, rival] = primaryIsPrior ? [prior, rec] : [rec, prior];
      byId.set(rec.legacy_id, keep);
      rivals.push(rival);
      const existing = conflicts.get(rec.legacy_id);
      if (existing) existing.rivals.push(rival.file);
      else conflicts.set(rec.legacy_id, { legacy_id: rec.legacy_id, primary: keep.file, rivals: [rival.file] });
    }
  }

  const records = [...byId.values()].sort((a, b) => (a.legacy_id < b.legacy_id ? -1 : 1));
  const relationships: Record<string, RelationshipFields> = {};
  for (const rec of records) {
    const fields = relationshipsOf(rec.kind, rec.body);
    if (Object.keys(fields).length > 0) relationships[rec.legacy_id] = fields;
  }

  const layouts: Array<"v1" | "v2"> = [];
  if (rels.some((r) => r.startsWith("decisions/") || r === "blackboard.jsonl" || r.startsWith("graph/") || r.startsWith("handoffs/"))) layouts.push("v1");
  if (rels.some((r) => r.startsWith("records/"))) layouts.push("v2");

  return {
    twiningDir,
    layouts,
    files,
    records,
    views: views.sort((a, b) => (a.file < b.file ? -1 : 1)),
    rivals,
    damaged: damaged.sort((a, b) => (a.file < b.file ? -1 : 1)),
    conflicts: [...conflicts.values()].sort((a, b) => (a.legacy_id < b.legacy_id ? -1 : 1)),
    relationships,
  };
}
