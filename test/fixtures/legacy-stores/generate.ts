/**
 * Reproducible legacy-store fixtures for the v3 migration (lane 02c, C21).
 *
 *   npx tsx test/fixtures/legacy-stores/generate.ts
 *
 * Writes two synthetic stores whose BYTES are committed, so the migration
 * tests read the same bytes every run and a manifest hash is stable:
 *
 *   v1-file-store/.twining/    — the 1.x file backend (blackboard.jsonl,
 *                                decisions/index.json + decisions/*.json,
 *                                graph/*.json, handoffs/, archive/)
 *   v2-records-tree/.twining/  — the 2.x sqlite era, records/ tree + config
 *                                version 2, deliberately WITHOUT twining.db
 *                                so tests rebuild the database themselves.
 *
 * Both carry the same logical cast so one expectation table covers both:
 * provisional / active / superseded (with and without `superseded_by`) /
 * overridden (with and without `overridden_by`) / archived (with and without
 * `archived_from`) / amended decisions, resolved and open posts, an
 * acknowledged and a pending handoff, entities and relations — plus the four
 * damaged shapes a real store grows: a malformed file, a file carrying git
 * conflict markers, a record whose `id` disagrees with its filename, and
 * records with no embedding.
 *
 * Nothing here imports the migration under test: fixtures must not be able to
 * agree with a bug in the thing they test.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Deterministic, valid ULIDs (Crockford base32: no I, L, O, U). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const id = (suffix: string): string => {
  const body = `01M3C21${suffix.toUpperCase()}`.padEnd(26, "0");
  // Guard, not decoration: a token containing I/L/O/U silently produces an id
  // the v3 envelope refuses, and the migration then reports "expected a ULID"
  // for a FIXTURE defect that looks like a migration bug.
  if (!ULID_RE.test(body)) throw new Error(`fixture id is not a ULID: ${body}`);
  return body;
};

export const IDS = {
  // decisions
  dActive: id("DACT1V"),
  dProvisional: id("DPR0V1"),
  dSupersededWith: id("DSPSW1"),
  dSupersededWithout: id("DSPSN1"),
  dSupersededOrphan: id("DSPS0R"),
  dOverriddenWith: id("DVRDW1"),
  dOverriddenWithout: id("DVRDN1"),
  dArchivedWith: id("DARCW1"),
  dArchivedWithout: id("DARCN1"),
  dArchivedFromProvisional: id("DARCPV"),
  dOverriddenByActor: id("DVRDAC"),
  dNonUtf8: id("DBYTES"),
  dAmended: id("DAMND1"),
  dOrphan: id("DRPHN1"),
  dIdMismatch: id("DMSMT1"),
  dMalformed: id("DBAD01"),
  dConflictMarkers: id("DCNFM1"),
  dDuplicated: id("DDPCT1"),
  // posts
  pOpenWarning: id("P0PENW"),
  pResolved: id("PRES0V"),
  pRelates: id("PRETS1"),
  pLegacyKind: id("PKYND1"),
  pArchived: id("PARCH1"),
  // graph
  eFile: id("EFMAP1"),
  eConcept: id("EC0NC1"),
  rAffects: id("RAFFC1"),
  // handoffs
  hPending: id("HPEND1"),
  hAcknowledged: id("HACK01"),
} as const;

/** The filename a record with a mismatched `id` field is stored under. */
export const ID_MISMATCH_FILENAME = id("DMSMTF");

/**
 * A second export row DECLARING `IDS.dDuplicated` with different bytes
 * (C21 A-REC-09): both are retained, the pair is a conflict, and neither is
 * silently admitted as the current value.
 */
export const DUPLICATE_DECL_FILENAME = id("DDPCT2");

const T = (n: string): string => `2026-08-${n}T09:00:00.000Z`;

// ---------------------------------------------------------------- decisions

interface LegacyDecision extends Record<string, unknown> {
  id: string;
  timestamp: string;
  agent_id: string;
  domain: string;
  scope: string;
  summary: string;
  context: string;
  rationale: string;
  constraints: string[];
  alternatives: Array<Record<string, unknown>>;
  depends_on: string[];
  confidence: string;
  status: string;
  reversible: boolean;
  affected_files: string[];
  affected_symbols: string[];
  commit_hashes: string[];
}

function decision(over: Partial<LegacyDecision> & { id: string }): LegacyDecision {
  return {
    timestamp: T("01"),
    agent_id: "agent-scribe",
    domain: "architecture",
    scope: "src/catalog/",
    summary: `decision ${over.id}`,
    context: "the 2026 catalog review",
    rationale: "recorded during the catalog review",
    rationale_source: "authored",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    status: "active",
    reversible: true,
    affected_files: ["src/catalog/index.ts"],
    affected_symbols: [],
    commit_hashes: [],
    provenance: { recorded_at: T("01"), branch: "main", commit_sha: "a".repeat(40) },
    ...over,
  } as LegacyDecision;
}

const decisions: LegacyDecision[] = [
  decision({
    id: IDS.dActive,
    summary: "catalog output publishes from the nightly build",
    status: "active",
    promoted_by: "agent-ratifier",
    promoted_at: T("02"),
    confidence: "high",
    supersedes: IDS.dSupersededWithout,
    constraints: ["publication waits for the index rebuild"],
    alternatives: [{ option: "publish on every merge", pros: ["fresher"], cons: ["noisy"], reason_rejected: "too noisy for consumers" }],
  }),
  decision({
    id: IDS.dProvisional,
    summary: "the ledger probably reconciles at 02:00",
    status: "provisional",
    confidence: "low",
    scope: "src/ledger/",
  }),
  decision({
    id: IDS.dSupersededWith,
    summary: "catalog output stays on publication hold",
    status: "superseded",
    superseded_by: IDS.dActive,
  }),
  decision({
    // Legacy ambiguity: retired with no pointer to the successor.
    id: IDS.dSupersededWithout,
    summary: "an earlier hold whose successor was never linked",
    status: "superseded",
  }),
  decision({
    // Pure ambiguity: retired with no pointer in EITHER direction.
    id: IDS.dSupersededOrphan,
    summary: "superseded with no recoverable successor",
    status: "superseded",
  }),
  decision({
    id: IDS.dOverriddenWith,
    summary: "weekly invoicing",
    status: "overridden",
    overridden_by: IDS.dActive,
    override_reason: "the billing review reversed it",
  }),
  decision({
    // Legacy ambiguity: overridden with no overridden_by (ADR §10.2's example).
    id: IDS.dOverriddenWithout,
    summary: "an override with no recorded overrider",
    status: "overridden",
  }),
  decision({
    id: IDS.dArchivedWith,
    summary: "end-of-cycle archive of a ratified decision",
    status: "archived",
    archived_from: "active",
  }),
  decision({
    // Archived out of PROVISIONAL. housekeeping's archive_stale sweep writes
    // exactly this shape, and its own description says "a provisional goes
    // back to the ratification queue" — so the migration has to keep the
    // record provisional under the archive flag, not silently ratify it.
    id: IDS.dArchivedFromProvisional,
    summary: "a provisional swept into the archive by archive_stale",
    status: "archived",
    archived_from: "provisional",
    confidence: "low",
  }),
  decision({
    // `overridden_by` holding an ACTOR label, which is what 1.x actually
    // wrote (`overriddenBy ?? "human"`), not a record id.
    id: IDS.dOverriddenByActor,
    summary: "overridden by a person, not by another decision",
    status: "overridden",
    overridden_by: "dave",
    override_reason: "reversed on the release call",
  }),
  decision({
    // Legacy ambiguity: archived with no remembered prior status.
    id: IDS.dArchivedWithout,
    summary: "archived before archived_from existed",
    status: "archived",
  }),
  decision({
    id: IDS.dAmended,
    summary: "invoice numbering uses the vendor sequence",
    status: "active",
    affected_files: ["src/catalog/index.ts", "src/billing/invoice.ts"],
    affected_symbols: ["renderInvoice"],
    amendments: [
      { amended_at: T("03"), amended_by: "agent-scribe", added_files: ["src/billing/invoice.ts"], added_symbols: [], reason: "found the real call site" },
      { amended_at: T("04"), amended_by: "agent-auditor", added_files: [], added_symbols: ["renderInvoice"], reason: "symbol-level precision" },
    ],
    depends_on: [IDS.dActive],
  }),
  decision({
    // Present on disk, deliberately ABSENT from decisions/index.json (v1 only):
    // the index-desync shape the 2.x migration already salvages by scan.
    id: IDS.dOrphan,
    summary: "written while the index write raced",
    status: "active",
    scope: "src/ops/",
  }),
  decision({
    id: IDS.dDuplicated,
    summary: "the reviewer meant the catalog output only",
    status: "active",
    scope: "src/catalog/",
  }),
  decision({
    // `id` disagrees with the filename it is stored under.
    id: IDS.dIdMismatch,
    summary: "stored under a filename that is not its id",
    status: "active",
    scope: "src/ops/",
  }),
];

// -------------------------------------------------------------------- posts

interface LegacyPost extends Record<string, unknown> {
  id: string;
  timestamp: string;
  agent_id: string;
  entry_type: string;
  tags: string[];
  scope: string;
  summary: string;
  detail: string;
}

const posts: LegacyPost[] = [
  {
    id: IDS.pOpenWarning,
    timestamp: T("05"),
    agent_id: "agent-scribe",
    entry_type: "warning",
    tags: ["catalog"],
    scope: "src/catalog/",
    summary: "the nightly build silently skips empty shards",
    detail: "Seen twice in the August runs; no alert fires.",
    provenance: { recorded_at: T("05"), branch: "main", commit_sha: "b".repeat(40) },
  },
  {
    id: IDS.pResolved,
    timestamp: T("06"),
    agent_id: "agent-auditor",
    entry_type: "need",
    tags: [],
    scope: "src/ledger/",
    summary: "need the reconciliation window confirmed",
    detail: "",
    status: "resolved",
    resolved_at: T("07"),
    resolved_by: "agent-scribe",
    resolution_note: "confirmed at 03:00 UTC",
  },
  {
    id: IDS.pRelates,
    timestamp: T("07"),
    agent_id: "agent-scribe",
    entry_type: "finding",
    tags: ["catalog"],
    scope: "src/catalog/",
    summary: "the skip is an empty-shard guard, not a bug",
    detail: "",
    relates_to: [IDS.pOpenWarning],
  },
  {
    // entry_type `decision` exists in 1.x/2.x stores but is NOT in the v3
    // post body enum — the migration must flag the coercion, never silently
    // relabel it (see v3-forward's legacy_ambiguity handling).
    id: IDS.pLegacyKind,
    timestamp: T("08"),
    agent_id: "agent-scribe",
    entry_type: "decision",
    tags: [],
    scope: "src/catalog/",
    summary: "posted as a decision-kind entry by a 1.x client",
    detail: "",
  },
];

const archivedPost: LegacyPost = {
  id: IDS.pArchived,
  timestamp: T("02"),
  agent_id: "agent-scribe",
  entry_type: "status",
  tags: [],
  scope: "src/catalog/",
  summary: "swept into the archive by the 1.x archiver",
  detail: "",
};

// -------------------------------------------------------------------- graph

const entities = [
  { id: IDS.eFile, name: "src/catalog/index.ts", type: "file", properties: { scopes: "src/catalog/" }, created_at: T("01"), updated_at: T("03") },
  { id: IDS.eConcept, name: "nightly build", type: "concept", properties: {}, created_at: T("01"), updated_at: T("01") },
];

const relations = [
  { id: IDS.rAffects, source: IDS.eFile, target: IDS.eConcept, type: "affects", properties: { origin: "declared" }, created_at: T("01") },
];

// ----------------------------------------------------------------- handoffs

const handoffs = [
  {
    id: IDS.hPending,
    created_at: T("09"),
    source_agent: "agent-scribe",
    target_agent: "agent-auditor",
    scope: "src/catalog/",
    summary: "catalog review handed to the auditor",
    results: [{ status: "partial", summary: "index rebuild verified" }],
    context_snapshot: { decision_ids: [IDS.dActive], warning_ids: [IDS.pOpenWarning], finding_ids: [], summaries: [] },
  },
  {
    id: IDS.hAcknowledged,
    created_at: T("10"),
    source_agent: "agent-auditor",
    target_agent: "agent-scribe",
    scope: "src/ledger/",
    summary: "ledger reconciliation handed back",
    results: [{ status: "completed", summary: "window confirmed" }],
    context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
    acknowledged_by: "agent-scribe",
    acknowledged_at: T("11"),
  },
];

// ------------------------------------------------------------ damaged files

/**
 * A legacy record whose file contains a byte sequence that is not valid UTF-8
 * (0xFF 0xFE inside a JSON string, as a latin-1 export or a truncated
 * multi-byte character would produce). Its JSON still parses as latin-1-ish
 * bytes, and the point is that the migration stores the BYTES: decoding them
 * to UTF-8 would map both to U+FFFD and the attachment would stop hashing to
 * its own filename.
 */
const NON_UTF8_BYTES = Buffer.concat([
  Buffer.from(`{\n  "agent_id": "agent-scribe",\n  "confidence": "medium",\n  "id": "${IDS.dNonUtf8}",\n  "rationale": "exported by a latin-1 client",\n  "scope": "src/catalog/",\n  "status": "active",\n  "summary": "byte `, "utf8"),
  Buffer.from([0xff, 0xfe]),
  Buffer.from(` survives",\n  "timestamp": "${T("01")}"\n}\n`, "utf8"),
]);

const MALFORMED_BYTES = '{"id": "' + IDS.dMalformed + '", "summary": "truncated mid-pay';
/** The rival body for the duplicate-declared id — different bytes, same id. */
const duplicateRival: LegacyDecision = decision({
  id: IDS.dDuplicated,
  summary: "the reviewer meant the whole story",
  status: "superseded",
  superseded_by: IDS.dActive,
  scope: "src/catalog/",
});

const CONFLICT_BYTES = [
  "<<<<<<< HEAD",
  JSON.stringify({ id: IDS.dConflictMarkers, summary: "ours", status: "active" }, null, 2),
  "=======",
  JSON.stringify({ id: IDS.dConflictMarkers, summary: "theirs", status: "superseded" }, null, 2),
  ">>>>>>> feature/catalog",
  "",
].join("\n");

// ------------------------------------------------------------------ writers

const stable = (v: unknown): string => {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x !== null && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) out[k] = sort((x as Record<string, unknown>)[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sort(v), null, 2) + "\n";
};

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Write raw BYTES — used for the fixture that is deliberately not UTF-8. */
function writeBytes(file: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeV1(root: string): void {
  const tw = path.join(root, ".twining");
  fs.rmSync(root, { recursive: true, force: true });

  write(path.join(tw, "config.yml"), "version: 1\nproject_name: quarrystone\nstorage:\n  backend: files\n");

  // blackboard.jsonl — one JSON object per line, append order.
  write(path.join(tw, "blackboard.jsonl"), posts.map((p) => JSON.stringify(p)).join("\n") + "\n");
  write(path.join(tw, "archive", "2026-08-02-blackboard.jsonl"), JSON.stringify(archivedPost) + "\n");

  // decisions: every decision except the orphan is indexed; the mismatch file
  // is stored under a filename that is not its id.
  const indexed = decisions.filter((d) => d.id !== IDS.dOrphan && d.id !== IDS.dIdMismatch);
  write(
    path.join(tw, "decisions", "index.json"),
    stable(indexed.map((d) => ({ id: d.id, timestamp: d.timestamp, scope: d.scope, summary: d.summary, status: d.status, confidence: d.confidence, domain: d.domain }))),
  );
  for (const d of decisions) {
    const file = d.id === IDS.dIdMismatch ? ID_MISMATCH_FILENAME : d.id;
    write(path.join(tw, "decisions", `${file}.json`), stable(d));
  }
  write(path.join(tw, "decisions", `${DUPLICATE_DECL_FILENAME}.json`), stable(duplicateRival));
  writeBytes(path.join(tw, "decisions", `${IDS.dNonUtf8}.json`), NON_UTF8_BYTES);
  write(path.join(tw, "decisions", `${IDS.dMalformed}.json`), MALFORMED_BYTES);
  write(path.join(tw, "decisions", `${IDS.dConflictMarkers}.json`), CONFLICT_BYTES);

  write(path.join(tw, "graph", "entities.json"), stable(entities));
  write(path.join(tw, "graph", "relations.json"), stable(relations));

  write(
    path.join(tw, "handoffs", "index.jsonl"),
    handoffs
      .map((h) =>
        JSON.stringify({
          id: h.id,
          created_at: h.created_at,
          source_agent: h.source_agent,
          target_agent: h.target_agent,
          scope: h.scope,
          summary: h.summary,
          result_status: h.results[0]?.status ?? "completed",
          acknowledged: h.acknowledged_by !== undefined,
        }),
      )
      .join("\n") + "\n",
  );
  for (const h of handoffs) write(path.join(tw, "handoffs", `${h.id}.json`), stable(h));

  write(path.join(tw, ".gitignore"), "embeddings/\ntwining.db\n");
}

function writeV2(root: string): void {
  const tw = path.join(root, ".twining");
  fs.rmSync(root, { recursive: true, force: true });

  write(path.join(tw, "config.yml"), "version: 2\nproject_name: quarrystone\nstorage:\n  backend: sqlite\n  export_records: true\n");

  for (const p of [...posts, archivedPost]) {
    write(path.join(tw, "records", "posts", p.timestamp.slice(0, 7), `${p.id}.json`), stable(p));
  }
  for (const d of decisions) {
    const file = d.id === IDS.dIdMismatch ? ID_MISMATCH_FILENAME : d.id;
    write(path.join(tw, "records", "decisions", `${file}.json`), stable(d));
  }
  write(path.join(tw, "records", "decisions", `${DUPLICATE_DECL_FILENAME}.json`), stable(duplicateRival));
  writeBytes(path.join(tw, "records", "decisions", `${IDS.dNonUtf8}.json`), NON_UTF8_BYTES);
  write(path.join(tw, "records", "decisions", `${IDS.dMalformed}.json`), MALFORMED_BYTES);
  write(path.join(tw, "records", "decisions", `${IDS.dConflictMarkers}.json`), CONFLICT_BYTES);

  for (const e of entities) write(path.join(tw, "records", "graph", "entities", `${e.id}.json`), stable(e));
  for (const r of relations) write(path.join(tw, "records", "graph", "relations", `${r.id}.json`), stable(r));
  for (const h of handoffs) write(path.join(tw, "records", "handoffs", `${h.id}.json`), stable(h));

  // No twining.db on purpose: the sqlite database is a derived, gitignored
  // cache, so the fixture ships only the committable tree and the tests
  // rebuild the database from it (which is also what a fresh clone does).
  write(path.join(tw, ".gitignore"), "twining.db\ntwining.db-wal\ntwining.db-shm\nrecords/**/*.tmp\n");
}

export const V1_ROOT = path.join(HERE, "v1-file-store");
export const V2_ROOT = path.join(HERE, "v2-records-tree");

/** Copy a fixture store into a scratch directory (never migrate in place). */
export function copyFixture(from: string, to: string): string {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return to;
}

function main(): void {
  writeV1(V1_ROOT);
  writeV2(V2_ROOT);
  console.log(`wrote ${V1_ROOT}`);
  console.log(`wrote ${V2_ROOT}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
