/**
 * `fs:` transport — a shared directory standing in for a remote (ADR §8.3).
 *
 * It is deliberately dumb: copy event files in, list what is new, write the
 * consumer's cursor. Everything interesting (admission, conflict, precedence)
 * belongs to the store, so the same slice must pass over this carrier and over
 * the in-process relay without a single assertion changing.
 *
 * Ordering comes from an append-only `index.jsonl`, not from ULID order:
 * two hosts minting concurrently produce interleaved ULIDs, so "files newer
 * than the cursor" has to mean "entries after this position in the carrier's
 * own log". A reconcile pass on every poll adopts any event file that was
 * copied in by hand (or by a changed layout — C14 T4), so a directory-level
 * rewrite never loses an event.
 */
import fs from "node:fs";
import path from "node:path";

import { computeEventDigest, eventEnvelopeSchema, type EventEnvelope } from "../contracts/index.js";
import type { Cursor, PublishReceipt, Transport, TransportHealth } from "../contracts/store-api.js";

export interface TransportFaults {
  /** Swallow the next consumer cursor ack (the carrier never learns the position). */
  dropNextAck?: boolean;
  /** Deliver the bytes but lose the producer's receipt — the C10/C11 lost ack. */
  dropNextPublishReceipt?: boolean;
  /** Return the next batch twice. */
  duplicateNext?: boolean;
  /** Permute a polled batch (reorder(queue)). */
  reorder?: (events: EventEnvelope[]) => EventEnvelope[];
}

export class LostReceiptError extends Error {
  constructor(readonly carrier: string) {
    super(`publish receipt lost on ${carrier}`);
    this.name = "LostReceiptError";
  }
}

interface IndexEntry {
  seq: number;
  id: string;
  digest: string;
  path: string;
  conflict?: boolean;
}

export class FsTransport implements Transport {
  readonly faults: TransportFaults = {};
  /** digest → carrier id for the most recent poll, so the inbox can record a representation. */
  readonly lastCarrierIds: Record<string, string> = {};
  private readonly root: string;

  constructor(sharedDir: string) {
    this.root = sharedDir;
    fs.mkdirSync(path.join(this.root, "events"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "cursors"), { recursive: true });
  }

  id(): string {
    return `fs:${this.root}`;
  }

  setFaults(faults: TransportFaults): void {
    Object.assign(this.faults, faults);
  }

  /** Idempotent by id + digest; a conflicting id keeps BOTH sets of bytes. */
  async publish(events: EventEnvelope[]): Promise<PublishReceipt> {
    const carrier_ids: Record<string, string> = {};
    for (const ev of events) {
      const shard = ev.occurred_at.slice(0, 7);
      const rel = path.posix.join("events", shard, `${ev.id}.json`);
      const abs = path.join(this.root, rel);
      const existing = this.readIfPresent(abs);
      if (existing && existing.digest === ev.digest) {
        carrier_ids[ev.digest] = rel; // already carried — the retry reconciles
        continue;
      }
      if (existing) {
        // Same id, different bytes: never overwrite. Carry the conflict so the
        // consumer can refuse it for itself rather than never seeing it.
        const crel = path.posix.join("conflicts", `${ev.id}.${ev.digest.slice(7, 19)}.json`);
        this.write(crel, ev);
        this.appendIndex({ id: ev.id, digest: ev.digest, path: crel, conflict: true });
        carrier_ids[ev.digest] = crel;
        continue;
      }
      this.write(rel, ev);
      this.appendIndex({ id: ev.id, digest: ev.digest, path: rel });
      carrier_ids[ev.digest] = rel;
    }
    if (this.faults.dropNextPublishReceipt) {
      this.faults.dropNextPublishReceipt = false;
      throw new LostReceiptError(this.id());
    }
    return { transport: this.id(), carrier_ids };
  }

  async poll(cursor: Cursor | null): Promise<{ events: EventEnvelope[]; cursor: Cursor }> {
    const index = this.reconcileIndex();
    const from = cursor ? Number(cursor.position) : 0;
    const fresh = index.filter((e) => e.seq > from);
    for (const e of fresh) this.lastCarrierIds[e.digest] = e.path;
    let events = fresh
      .map((e) => this.readIfPresent(path.join(this.root, e.path))?.envelope)
      .filter((e): e is EventEnvelope => e !== undefined);
    if (this.faults.reorder) events = this.faults.reorder(events);
    if (this.faults.duplicateNext) {
      this.faults.duplicateNext = false;
      events = [...events, ...events];
    }
    const position = String(index.at(-1)?.seq ?? from);
    return { events, cursor: { transport: this.id(), position } };
  }

  async ack(consumer: string, cursor: Cursor): Promise<void> {
    if (this.faults.dropNextAck) {
      this.faults.dropNextAck = false;
      return; // the carrier never learns this consumer moved
    }
    fs.writeFileSync(path.join(this.root, "cursors", `${consumer}.json`), JSON.stringify(cursor, null, 2));
  }

  async health(): Promise<TransportHealth> {
    return { reachable: fs.existsSync(this.root), lag_events: this.reconcileIndex().length, credential_state: "ok" };
  }

  /** The cursor the carrier believes a consumer has reached (ADR §5). */
  consumerCursor(principal: string): Cursor | null {
    const file = path.join(this.root, "cursors", `${principal}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Cursor;
  }

  // ------------------------------------------------------------- internals

  private get indexFile(): string {
    return path.join(this.root, "index.jsonl");
  }

  private readIndex(): IndexEntry[] {
    if (!fs.existsSync(this.indexFile)) return [];
    return fs
      .readFileSync(this.indexFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as IndexEntry);
  }

  /** Adopt any event file present on the carrier but missing from the log. */
  private reconcileIndex(): IndexEntry[] {
    const index = this.readIndex();
    const known = new Set(index.map((e) => e.path));
    const found: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const rel = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.name.endsWith(".json")) found.push(rel);
      }
    };
    walk(path.join(this.root, "events"), "events");
    walk(path.join(this.root, "conflicts"), "conflicts");
    for (const rel of found) {
      if (known.has(rel)) continue;
      const read = this.readIfPresent(path.join(this.root, rel));
      if (!read) continue;
      this.appendIndex({ id: read.envelope.id, digest: read.digest, path: rel, ...(rel.startsWith("conflicts/") ? { conflict: true } : {}) });
    }
    return this.readIndex();
  }

  private appendIndex(entry: Omit<IndexEntry, "seq">): void {
    const seq = this.readIndex().length + 1;
    fs.appendFileSync(this.indexFile, `${JSON.stringify({ seq, ...entry })}\n`);
  }

  private write(rel: string, ev: EventEnvelope): void {
    const abs = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ev, null, 2));
    fs.renameSync(tmp, abs);
  }

  private readIfPresent(abs: string): { envelope: EventEnvelope; digest: string } | null {
    if (!fs.existsSync(abs)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
      const parsed = eventEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return null;
      return { envelope: parsed.data, digest: typeof raw.digest === "string" ? raw.digest : computeEventDigest(raw) };
    } catch {
      return null;
    }
  }
}
