/**
 * Outbox — the producer half (ADR §5).
 *
 * The rule the whole case turns on: after a lost receipt the producer retries
 * the SAME event id and digest. It never mints a fresh identity for an
 * operation whose outcome is uncertain (C10 N1, C11 A11). The uncertainty
 * window is retained after it closes — reconciliation records uncertainty, it
 * does not erase it (C10 A09).
 */
import type { EventStore } from "../events/event-store.js";
import type { Cursor, Transport } from "../contracts/store-api.js";
import { LostReceiptError } from "./fs-transport.js";

export interface FlushResult {
  attempted: string[];
  transferred: string[];
  /** Sent, but the receipt never came back — retried by the next flush. */
  uncertain: string[];
  carrier_ids: Record<string, string>;
}

export class Outbox {
  constructor(
    private readonly store: EventStore,
    private readonly transport: Transport,
  ) {}

  async flush(): Promise<FlushResult> {
    const pending = this.store.outboxPending(this.transport.id());
    const result: FlushResult = { attempted: pending.map((e) => e.id), transferred: [], uncertain: [], carrier_ids: {} };
    if (pending.length === 0) return result;

    for (const ev of pending) this.store.recordPublishAttempt(this.transport.id(), ev.id, ev.digest);

    try {
      const receipt = await this.transport.publish(pending);
      for (const ev of pending) {
        const carrierId = receipt.carrier_ids[ev.digest];
        if (!carrierId) {
          result.uncertain.push(ev.id);
          continue;
        }
        this.store.recordPublishReceipt(this.transport.id(), ev.id, carrierId);
        result.transferred.push(ev.id);
        result.carrier_ids[ev.id] = carrierId;
      }
    } catch (err) {
      if (!(err instanceof LostReceiptError)) throw err;
      // The bytes may well have landed. We do not know, so we say we do not
      // know, and the next flush retries the identical ids (never new ones).
      result.uncertain = pending.map((e) => e.id);
    }
    return result;
  }
}

/**
 * "Fully exchanged" is only definable against an explicit membership `M` and
 * an event cut `E` (ADR §5). An unreachable replica keeps it false; it never
 * silently becomes true.
 */
export function fullyExchanged(
  carrier: { consumerCursor(principal: string): Cursor | null },
  members: string[],
  cut: string,
): { fully_exchanged: boolean; behind: string[] } {
  const behind = members.filter((p) => {
    const c = carrier.consumerCursor(p);
    return !c || (c.last_admitted ?? "") < cut;
  });
  return { fully_exchanged: behind.length === 0, behind };
}
