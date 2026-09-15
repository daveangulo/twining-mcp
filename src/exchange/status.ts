/**
 * Exchange observability (R20) — `exchangeStatus()`.
 *
 * The one surface an operator (or a lane-03 CLI, or a lane-04 packet) can read
 * to answer "what is this replica uncertain about?". Three rules shape it:
 *
 *  1. **Every number is derivable from a durable row.** Nothing here is a
 *     counter incremented in memory, so a restart does not reset the picture
 *     and the report survives losing the projection (C18 A9).
 *  2. **The two ladders stay apart** (R08): the admission ladder lives on
 *     journal rows, the transfer ladder on outbox rows per transport, and
 *     neither is folded into the other.
 *  3. **Uncertainty is enumerated, not smoothed.** `gaps` carries the things
 *     this replica knows it does not know — a checkout behind its journal, a
 *     forked cursor, an unresolved import, an open purge obligation. A status
 *     report that could not say "I do not know" would be the failure C18's A9
 *     and C20's E4 are written against.
 *
 * `migration` is a declared placeholder: lane 02c owns migrate/rollback, and
 * reporting `unknown` is the honest answer until it lands — not `complete`.
 */
import type { EventStore } from "../events/event-store.js";
import type { TransportHealth } from "../contracts/store-api.js";

export interface ExchangeGap {
  kind: "checkout_behind_journal" | "cursor_fork" | "pending_import" | "pending_parents" | "uncertain_transfer" | "open_erasure_obligation";
  detail: string;
  ids: string[];
}

export interface ExchangeStatus {
  generated_at: string;
  store: {
    twining_dir: string;
    events_held: number;
    admitted: number;
    projected: number;
    checkout: "ok" | "checkout_behind_journal";
  };
  /** Producer side: what has not left this host yet, per transport. */
  outbox: {
    depth: number;
    oldest_pending_age_ms: number | null;
    oldest_pending_id: string | null;
    retries: number;
    uncertain: string[];
    by_transport: Array<{ transport: string; queued: number; transferred: number; uncertain: number; attempts: number }>;
  };
  /** Consumer side: what arrived but has not been applied. */
  inbound: {
    received: number;
    pending_parents: Array<{ id: string; waiting_on: string[] }>;
  };
  rejected: { count: number; by_reason: Record<string, number> };
  quarantined: { count: number; retryable: number; by_reason: Record<string, number> };
  ingest_attempts: { count: number; retries: number; by_disposition: Record<string, number>; by_reason: Record<string, number> };
  cursors: Array<{ principal: string; transport: string; position: string; last_admitted?: string }>;
  cursor_forks: Array<{ principal: string; positions: string[] }>;
  transports: Array<{ id: string } & TransportHealth>;
  gaps: ExchangeGap[];
  /** Keys revoked after events they signed were admitted — history kept, flagged. */
  revoked_credentials: Array<{ event_id: string; principal: string }>;
  migration: { state: "unknown"; note: string };
}

export interface ExchangeStatusOptions {
  /** Live carriers to probe. Probing is optional: a status call must work offline. */
  transports?: Array<{ id(): string; health(): Promise<TransportHealth> }>;
  /** Injected clock for age arithmetic (audit only — never an ordering input). */
  now?: () => number;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export async function exchangeStatus(store: EventStore, opts: ExchangeStatusOptions = {}): Promise<ExchangeStatus> {
  const now = opts.now ?? (() => Date.now());
  const rows = store.journalRows();
  const canonical = rows.filter((r) => r.canonical);
  const outbox = store.outboxRows();
  const checkout = store.checkoutStatus();
  const pendingImports = store.pendingImports();
  const attempts = store.ingestAttempts();
  const forks = store.cursorForks();

  const admittedIds = new Set(canonical.filter((r) => r.state === "admitted" || r.state === "projected").map((r) => r.id));
  const untransferred = canonical.filter((r) => r.state !== "rejected" && !outbox.some((o) => o.event_id === r.id && o.acked));
  const ages = untransferred
    .map((r) => ({ id: r.id, at: Date.parse(r.first_seen) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  const oldest = ages[0];

  const byTransport = new Map<string, { transport: string; queued: number; transferred: number; uncertain: number; attempts: number }>();
  for (const o of outbox) {
    const slot = byTransport.get(o.transport) ?? { transport: o.transport, queued: 0, transferred: 0, uncertain: 0, attempts: 0 };
    if (o.state === "transferred") slot.transferred += 1;
    else slot.queued += 1;
    if (o.uncertain) slot.uncertain += 1;
    slot.attempts += o.attempts;
    byTransport.set(o.transport, slot);
  }

  const quarantinedRows = rows.filter((r) => r.state === "quarantined");
  const rejectedRows = rows.filter((r) => r.state === "rejected");
  const pendingParents = canonical
    .filter((r) => r.state === "pending_parents")
    .map((r) => ({ id: r.id, waiting_on: r.pending_on ?? [] }));

  const gaps: ExchangeGap[] = [];
  if (checkout.status === "checkout_behind_journal") {
    gaps.push({
      kind: "checkout_behind_journal",
      detail: "the checkout no longer holds every event file this replica admitted; the journal retains them and nothing was revoked",
      ids: checkout.missing,
    });
  }
  for (const f of forks) gaps.push({ kind: "cursor_fork", detail: `two cursors for ${f.principal} disagree (${f.positions.join(" vs ")})`, ids: [f.principal] });
  for (const p of pendingImports) gaps.push({ kind: "pending_import", detail: `${p.reason} on ${p.carrier}`, ids: p.missing.length > 0 ? p.missing : [p.batch_id] });
  if (pendingParents.length > 0) {
    gaps.push({ kind: "pending_parents", detail: "admitted-but-not-applied: prerequisites have not arrived", ids: pendingParents.map((p) => p.id) });
  }
  const uncertain = outbox.filter((o) => o.uncertain).map((o) => o.event_id);
  if (uncertain.length > 0) {
    gaps.push({ kind: "uncertain_transfer", detail: "the bytes may have landed; the receipt never came back. The same id is retried, never a new one.", ids: [...new Set(uncertain)].sort() });
  }
  const openErasures = store.localErasures().filter((e) => e.op === "purge");
  if (openErasures.length > 0) {
    gaps.push({
      kind: "open_erasure_obligation",
      detail: "local bytes are destroyed; remote clones, carrier history and backups are NOT erased and are never reported as erased",
      ids: openErasures.map((e) => e.record_id),
    });
  }

  const transports: Array<{ id: string } & TransportHealth> = [];
  for (const t of opts.transports ?? []) {
    try {
      transports.push({ id: t.id(), ...(await t.health()) });
    } catch (err) {
      transports.push({ id: t.id(), reachable: false, last_error: (err as Error).message, credential_state: "unknown" });
    }
  }

  return {
    generated_at: store.nowStamp(),
    store: {
      twining_dir: store.twiningDir,
      events_held: rows.length,
      admitted: admittedIds.size,
      projected: canonical.filter((r) => r.state === "projected").length,
      checkout: checkout.status,
    },
    outbox: {
      depth: untransferred.length,
      oldest_pending_age_ms: oldest ? Math.max(0, now() - oldest.at) : null,
      oldest_pending_id: oldest?.id ?? null,
      retries: outbox.reduce((n, o) => n + Math.max(0, o.attempts - 1), 0),
      uncertain: [...new Set(uncertain)].sort(),
      by_transport: [...byTransport.values()].sort((a, b) => (a.transport < b.transport ? -1 : 1)),
    },
    inbound: { received: canonical.filter((r) => r.state === "received").length, pending_parents: pendingParents },
    rejected: { count: rejectedRows.length, by_reason: tally(rejectedRows.map((r) => r.reason ?? "unspecified")) },
    quarantined: {
      count: quarantinedRows.length,
      retryable: quarantinedRows.filter((r) => ["signature_required", "unauthorized_principal", "attachment_missing", "signer_unknown", "no_policy_yet"].includes(r.reason ?? "")).length,
      by_reason: tally(quarantinedRows.map((r) => r.reason ?? "unspecified")),
    },
    ingest_attempts: {
      count: attempts.length,
      retries: attempts.reduce((n, a) => n + Math.max(0, a.retry_count - 1), 0),
      by_disposition: tally(attempts.map((a) => a.disposition)),
      by_reason: tally(attempts.map((a) => a.reason)),
    },
    cursors: store.allCursors().map((c) => ({
      principal: c.principal,
      transport: c.cursor.transport,
      position: c.cursor.position,
      ...(c.cursor.last_admitted ? { last_admitted: c.cursor.last_admitted } : {}),
    })),
    cursor_forks: forks,
    transports,
    gaps,
    revoked_credentials: rows.filter((r) => r.key_revoked_after).map((r) => ({ event_id: r.id, principal: r.producer })),
    migration: {
      state: "unknown",
      note: "migration state is owned by the migrate/rollback lane; this replica reports `unknown` rather than claiming a state it does not track",
    },
  };
}
