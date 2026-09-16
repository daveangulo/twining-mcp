/**
 * Reference relay (ADR §8.3, §9.3) — an in-process append-only log service.
 *
 * It exists to prove the delivery state machine is carrier-independent: the
 * same slice tests run against `FsTransport` and against this, and nothing but
 * the carrier id changes. It is a test oracle, not a deployed service.
 *
 * What it models that a directory cannot: a bearer token per principal, an
 * operation id per accepted write, reconciliation of a retried operation by
 * id + digest (never a second op), and an ack that can be lost on the way back.
 */
import type { EventEnvelope } from "../contracts/index.js";
import type { Cursor, PublishReceipt, Transport, TransportHealth } from "../contracts/store-api.js";
import { LostReceiptError, type TransportFaults } from "./fs-transport.js";

export class RelayAuthError extends Error {
  constructor(principal: string) {
    super(`relay: bearer token rejected for ${principal}`);
    this.name = "RelayAuthError";
  }
}

interface RelayEntry {
  seq: number;
  op: string;
  id: string;
  digest: string;
  envelope: EventEnvelope;
  producer: string;
  conflict?: boolean;
}

export class ReferenceRelay {
  private readonly entries: RelayEntry[] = [];
  private readonly tokens = new Map<string, string>();
  private readonly cursors = new Map<string, Cursor>();
  private ops = 0;
  /** Drop the next publish receipt (the write lands, the producer never hears). */
  simulateLostAck = false;

  constructor(readonly url = "relay://reference") {}

  register(principal: string, token: string): void {
    this.tokens.set(principal, token);
  }

  /** A Transport bound to one authenticated principal. */
  client(principal: string, token: string): RelayClient {
    return new RelayClient(this, principal, token);
  }

  log(): ReadonlyArray<RelayEntry> {
    return this.entries;
  }

  consumerCursor(principal: string): Cursor | null {
    return this.cursors.get(principal) ?? null;
  }

  authenticate(principal: string, token: string): void {
    if (this.tokens.get(principal) !== token) throw new RelayAuthError(principal);
  }

  /** Append-only. Idempotent by id + digest; a conflicting id gets its own op. */
  submit(principal: string, events: EventEnvelope[]): Record<string, string> {
    const carrier_ids: Record<string, string> = {};
    for (const ev of events) {
      const same = this.entries.find((e) => e.id === ev.id && e.digest === ev.digest);
      if (same) {
        carrier_ids[ev.digest] = same.op; // the retry reconciles onto the SAME op
        continue;
      }
      const clash = this.entries.find((e) => e.id === ev.id && !e.conflict);
      this.ops += 1;
      const entry: RelayEntry = {
        seq: this.entries.length + 1,
        op: `op_${String(this.ops).padStart(4, "0")}`,
        id: ev.id,
        digest: ev.digest,
        envelope: ev,
        producer: principal,
        ...(clash ? { conflict: true } : {}),
      };
      this.entries.push(entry);
      carrier_ids[ev.digest] = entry.op;
    }
    return carrier_ids;
  }

  read(from: number): RelayEntry[] {
    return this.entries.filter((e) => e.seq > from);
  }

  setCursor(principal: string, cursor: Cursor): void {
    this.cursors.set(principal, cursor);
  }
}

export class RelayClient implements Transport {
  readonly faults: TransportFaults = {};
  /** digest → op id for the most recent poll (the relay's carrier identity). */
  readonly lastCarrierIds: Record<string, string> = {};

  constructor(
    private readonly relay: ReferenceRelay,
    private readonly principal: string,
    private readonly token: string,
  ) {}

  id(): string {
    return `relay:${this.relay.url}`;
  }

  setFaults(faults: TransportFaults): void {
    Object.assign(this.faults, faults);
  }

  async publish(events: EventEnvelope[]): Promise<PublishReceipt> {
    this.relay.authenticate(this.principal, this.token);
    const carrier_ids = this.relay.submit(this.principal, events);
    if (this.faults.dropNextPublishReceipt || this.relay.simulateLostAck) {
      this.faults.dropNextPublishReceipt = false;
      this.relay.simulateLostAck = false;
      throw new LostReceiptError(this.id());
    }
    return { transport: this.id(), carrier_ids };
  }

  async poll(cursor: Cursor | null): Promise<{ events: EventEnvelope[]; cursor: Cursor }> {
    this.relay.authenticate(this.principal, this.token);
    const from = cursor ? Number(cursor.position) : 0;
    const fresh = this.relay.read(from);
    for (const e of fresh) this.lastCarrierIds[e.digest] = e.op;
    let events = fresh.map((e) => e.envelope);
    if (this.faults.reorder) events = this.faults.reorder(events);
    if (this.faults.duplicateNext) {
      this.faults.duplicateNext = false;
      events = [...events, ...events];
    }
    const position = String(this.relay.log().at(-1)?.seq ?? from);
    return { events, cursor: { transport: this.id(), position } };
  }

  async ack(consumer: string, cursor: Cursor): Promise<void> {
    this.relay.authenticate(this.principal, this.token);
    if (this.faults.dropNextAck) {
      this.faults.dropNextAck = false;
      return;
    }
    this.relay.setCursor(consumer, cursor);
  }

  async health(): Promise<TransportHealth> {
    return { reachable: true, lag_events: this.relay.log().length, credential_state: this.relay.log() ? "ok" : "unknown" };
  }

  consumerCursor(principal: string): Cursor | null {
    return this.relay.consumerCursor(principal);
  }
}
