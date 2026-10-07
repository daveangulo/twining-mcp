/**
 * Migration status: twining_migrate_status.
 *
 * A READ. The migration verbs themselves are CLI-only (`twining migrate --to 3`,
 * `twining rollback --to 2`): they rewrite the store's format, and a format
 * change triggered from inside an agent's tool loop — possibly mid-session,
 * possibly concurrently with another agent's writes — is exactly the class of
 * action the ADR keeps behind an explicit operator verb (§8.2's rule for
 * `twining sync` applies with more force here).
 *
 * What this command answers instead: which format is on disk, whether a
 * migration is complete, incomplete (interrupted) or rolled back, which steps
 * remain, and how much is retained. An interrupted run reads `incomplete`, and
 * never `complete` (C21 A-INT-01).
 */
import { z } from "zod";
import { commandFactory, type CommandDef } from "../command-def.js";
import { migrateStatus, type MigrateStatus } from "../../migrate/v3-forward.js";

export interface MigrateCtx {
  twiningDir: string;
}

const { define } = commandFactory<MigrateCtx>();

export interface MigrateStatusResult extends MigrateStatus {
  /** The verb an operator would run next, or null when nothing is pending. */
  next_command: string | null;
  /** True while the store is rolled back: v3 functionality is unavailable. */
  rolled_back: boolean;
}

export const migrateCommands: CommandDef<MigrateCtx>[] = [
  define({
    name: "twining_migrate_status",
    surface: "full",
    description:
      "Report the .twining/ store format and migration state: not_started / incomplete (interrupted) / complete / rolled_back, the steps still to run, and what is retained (events, attachments, legacy manifest, id map).",
    input: {},
    async handler(ctx) {
      const status = migrateStatus(ctx.twiningDir);
      const rolledBack = status.migration === "rolled_back";
      const next =
        status.migration === "complete"
          ? null
          : status.migration === "rolled_back"
            ? "twining migrate --to 3   (re-upgrade; post-rollback writes are preserved)"
            : status.migration === "incomplete"
              ? "twining migrate --to 3   (resume: the interrupted run left config.version unchanged)"
              : "twining migrate --to 3 --dry-run   (writes legacy/manifest.json and nothing else)";
      const result: MigrateStatusResult = { ...status, next_command: next, rolled_back: rolledBack };
      return result;
    },
  }),
];
