/**
 * Exchange observability command: `twining_exchange_status` (R20).
 *
 * One command, registered on the DEFAULT surface, so both front ends reach the
 * same report: MCP through `registerCommands`, the CLI through argv. It is a
 * read: it opens the v3 event store, reports, and closes. It never runs git —
 * `twining sync` is the explicit verb that does that (ADR §8.2, §0) — so a
 * status call is safe in a server process and cannot touch the user's checkout.
 *
 * Registered on the default surface deliberately: "what is this replica
 * uncertain about?" is the question an agent should be able to ask without an
 * operator widening the tool surface first. The whole point of R20 is that
 * uncertainty is visible by default.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { commandFactory, CommandError, type CommandDef } from "../command-def.js";
import { EventStore } from "../../events/event-store.js";
import { eventsDbPath } from "../../events/db.js";

/** The narrow slice of context this command needs — nothing but the store dir. */
export interface ExchangeCtx {
  twiningDir: string;
}

const { define } = commandFactory<ExchangeCtx>();

export const exchangeCommands: CommandDef<ExchangeCtx>[] = [
  define({
    name: "twining_exchange_status",
    surface: "default",
    description:
      "Report the exchange state of this replica: outbox depth and the age of the oldest pending event, per-transport transfer state, inbound events waiting on prerequisites, rejected and quarantined counts with their reasons, retained ingest attempts, per-consumer cursors and cursor forks, and the gaps this replica knows it has (a checkout behind its journal, an unresolved import, an uncertain transfer, an open erasure obligation). Read-only; never runs git.",
    input: {
      include_ids: z
        .boolean()
        .optional()
        .describe("Include the event ids behind each gap and each uncertain transfer (default true)"),
    },
    async handler(ctx, args) {
      if (!fs.existsSync(path.dirname(eventsDbPath(ctx.twiningDir))) && !fs.existsSync(path.join(ctx.twiningDir, "events"))) {
        throw new CommandError(
          `no v3 event store at ${ctx.twiningDir} — this project has not been migrated to the event log yet`,
          "NO_EVENT_STORE",
        );
      }
      const store = new EventStore({ twiningDir: ctx.twiningDir });
      try {
        const status = await store.exchangeStatus();
        if (args.include_ids === false) {
          return {
            ...status,
            gaps: status.gaps.map(({ kind, detail, ids }) => ({ kind, detail, count: ids.length })),
            outbox: { ...status.outbox, uncertain: status.outbox.uncertain.length },
            inbound: { ...status.inbound, pending_parents: status.inbound.pending_parents.length },
          };
        }
        return status;
      } finally {
        store.close();
      }
    },
  }),
];
