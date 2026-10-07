/**
 * Inbox — the consumer half of the delivery state machine (ADR §5).
 *
 * received → admitted → projected, then the cursor moves and the carrier is
 * acked. Every stage stays separately observable through `deliveryState()`;
 * the inbox never reports a later stage than it actually reached, and it never
 * produces anything resembling task acceptance.
 */
import type { EventStore } from "../events/event-store.js";
import type { Cursor, Transport } from "../contracts/store-api.js";

export interface InboxResult {
  polled: number;
  received: string[];
  duplicates: string[];
  conflicts: string[];
  admitted: string[];
  pending_parents: string[];
  quarantined: string[];
  rejected: string[];
  cursor: Cursor;
  /** False when the carrier never learned our position (a dropped ack). */
  acked: boolean;
}

export class Inbox {
  constructor(
    private readonly store: EventStore,
    private readonly transport: Transport,
    private readonly principal: string,
  ) {}

  /** One delivery cycle. Safe to call repeatedly; redelivery is a no-op. */
  async pull(): Promise<InboxResult> {
    const before = await this.store.cursor(this.principal);
    const { events, cursor } = await this.transport.poll(before);
    const result: InboxResult = {
      polled: events.length,
      received: [],
      duplicates: [],
      conflicts: [],
      admitted: [],
      pending_parents: [],
      quarantined: [],
      rejected: [],
      cursor,
      acked: false,
    };

    const carrierIds = (this.transport as { lastCarrierIds?: Record<string, string> }).lastCarrierIds ?? {};
    for (const ev of events) {
      const r = this.store.receive(ev, this.transport.id(), carrierIds[ev.digest]);
      if (r.reason === "conflicting_duplicate") result.conflicts.push(r.id);
      else if (r.duplicate) result.duplicates.push(r.id);
      else result.received.push(r.id);
    }

    const outcomes = await this.store.admit();
    for (const o of outcomes) {
      if (o.state === "admitted") result.admitted.push(o.id);
      else if (o.state === "pending_parents") result.pending_parents.push(o.id);
      else if (o.state === "quarantined") result.quarantined.push(o.id);
      else result.rejected.push(o.id);
    }
    await this.store.project();

    const admittedIds = (await this.store.events({})).map((e) => e.id).sort();
    const next: Cursor = { ...cursor, ...(admittedIds.at(-1) ? { last_admitted: admittedIds.at(-1) as string } : {}) };
    await this.store.setCursor(this.principal, next);
    result.cursor = next;

    await this.transport.ack(this.principal, next);
    const carrier = this.transport as { consumerCursor?: (p: string) => Cursor | null };
    result.acked = carrier.consumerCursor?.(this.principal)?.position === next.position;
    return result;
  }

  /** Cursor rewind (C10 T8): replay from an earlier carrier position. */
  async rewind(position: string): Promise<void> {
    const current = (await this.store.cursor(this.principal)) ?? { transport: this.transport.id(), position };
    await this.store.setCursor(this.principal, { ...current, position });
  }
}
