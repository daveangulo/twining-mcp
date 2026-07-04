/**
 * Processes pending posts and actions queued to `.twining/`.
 * Reads `pending-posts.jsonl` and `pending-actions.jsonl`, processes each line,
 * then clears the files. One failure doesn't block others.
 *
 * Drain is callable repeatedly (`processPending`), not just at startup —
 * `processOnStartup` is a thin alias kept for call-site clarity. This is what
 * lets server.ts also run it on a periodic timer, so posts appended by the
 * subagent-stop hook while the server is already up don't sit stuck until
 * the next restart.
 */
import fs from "node:fs";
import path from "node:path";
import type { BlackboardEngine } from "./blackboard.js";
import type { Archiver } from "./archiver.js";

interface PendingPost {
  entry_type: string;
  summary: string;
  detail?: string;
  tags?: string[];
  scope?: string;
  agent_id?: string;
  relates_to?: string[];
}

interface PendingAction {
  action: string;
  [key: string]: unknown;
}

export class PendingProcessor {
  private readonly twiningDir: string;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly archiver: Archiver | null;

  constructor(
    twiningDir: string,
    blackboardEngine: BlackboardEngine,
    archiver: Archiver | null,
  ) {
    this.twiningDir = twiningDir;
    this.blackboardEngine = blackboardEngine;
    this.archiver = archiver;
  }

  /**
   * Process all pending posts and actions currently queued.
   * Returns counts of processed items. Never throws — failures are logged.
   *
   * Safe to call repeatedly (startup, and again on a periodic timer): drain
   * uses a rename-based swap rather than read-then-truncate, so a line
   * appended by a hook while a drain is in flight is never lost (see
   * `drainJsonlFile`).
   */
  async processPending(): Promise<{
    posts_processed: number;
    actions_processed: number;
  }> {
    const posts_processed = await this.drainJsonlFile<PendingPost>(
      path.join(this.twiningDir, "pending-posts.jsonl"),
      async (post) => {
        await this.blackboardEngine.post({
          entry_type: post.entry_type as "finding",
          summary: post.summary,
          detail: post.detail ?? "",
          tags: post.tags ?? [],
          scope: post.scope ?? "project",
          agent_id: post.agent_id ?? "pending-processor",
          relates_to: post.relates_to,
        });
      },
      "pending post",
    );

    const actions_processed = await this.drainJsonlFile<PendingAction>(
      path.join(this.twiningDir, "pending-actions.jsonl"),
      async (action) => {
        if (action.action === "archive" && this.archiver) {
          await this.archiver.archive({
            before: action.before as string | undefined,
          });
        }
        // Other action types can be added here in the future
      },
      "pending action",
    );

    return { posts_processed, actions_processed };
  }

  /**
   * Backward-compatible name for the startup call site. Identical behavior
   * to `processPending` — kept so "process on startup" reads clearly at the
   * call site in server.ts, alongside the periodic-drain call.
   */
  async processOnStartup(): Promise<{
    posts_processed: number;
    actions_processed: number;
  }> {
    return this.processPending();
  }

  /**
   * Drain a pending-queue JSONL file, applying `handler` to each parsed
   * line, and return the number of lines successfully processed.
   *
   * Concurrency design: the old implementation read the file, processed it,
   * then truncated it (`writeFileSync(path, "")`). That truncate wipes
   * whatever is on disk *at truncate time* — including a line the
   * subagent-stop hook appended (via unlocked `>>`) between the read and
   * the truncate. That window would silently LOSE a post.
   *
   * Fix: rename the live file to a swap name unique to THIS drain call
   * (`<file>.processing.<pid>.<random>`), then read/process/delete the
   * renamed copy. Appenders use create-if-missing writes (bash `>>`,
   * `fs.appendFileSync`), so anything appended after the rename lands in a
   * brand-new file at the original path and is simply picked up by the
   * *next* drain — never lost. The unique name matters: with a SHARED swap
   * name, drainer A's cleanup `rmSync` could land between drainer B's
   * rename and B's read, unlinking B's batch unread. With per-drain names
   * no drainer ever touches another drainer's swap file, so under
   * concurrent drains a post can be processed twice (both drainers claim
   * different batches, or a leftover is recovered while its owner is mid-
   * crash-recovery) but never lost. At-least-once semantics: duplicates
   * possible, loss is not.
   *
   * Crash recovery: a drainer that renamed but died before deleting leaves
   * `<file>.processing.<pid>.<random>` behind. Every drain first scans the
   * directory for such leftovers and CLAIMS each by renaming it to its own
   * unique name before reading (claim-by-rename — a loser's rename throws
   * ENOENT, which is benign: another drainer owns it).
   */
  private async drainJsonlFile<T>(
    filePath: string,
    handler: (item: T) => Promise<void>,
    label: string,
  ): Promise<number> {
    let processed = 0;

    // Recover leftover swap files from prior drains that renamed but
    // crashed before cleanup — claim and process them before the live file.
    const dir = path.dirname(filePath);
    const leftoverPrefix = `${path.basename(filePath)}.processing.`;
    let dirEntries: string[] = [];
    try {
      dirEntries = fs.readdirSync(dir);
    } catch {
      // Directory missing entirely — nothing pending, nothing to recover.
      return 0;
    }
    for (const entry of dirEntries) {
      if (!entry.startsWith(leftoverPrefix)) continue;
      const claimPath = this.makeSwapPath(filePath);
      try {
        fs.renameSync(path.join(dir, entry), claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue; // another drainer claimed it first — benign
        }
        throw error;
      }
      processed += await this.drainSwappedFile(claimPath, handler, label);
    }

    if (!fs.existsSync(filePath)) {
      return processed;
    }

    const swapPath = this.makeSwapPath(filePath);
    try {
      fs.renameSync(filePath, swapPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Another drain call/process already swapped it out first.
        return processed;
      }
      throw error;
    }

    processed += await this.drainSwappedFile(swapPath, handler, label);
    return processed;
  }

  /** Swap-file name unique to this drain call — never shared across drainers. */
  private makeSwapPath(filePath: string): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${filePath}.processing.${process.pid}.${rand}`;
  }

  /** Read, process, and delete a swap file this drain call owns. */
  private async drainSwappedFile<T>(
    swapPath: string,
    handler: (item: T) => Promise<void>,
    label: string,
  ): Promise<number> {
    let processed = 0;
    let content: string;
    try {
      content = fs.readFileSync(swapPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Shouldn't happen post-claim, but a vanished swap file just means
        // there is nothing to process — benign.
        return 0;
      }
      throw error;
    }
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const item = JSON.parse(line) as T;
        await handler(item);
        processed++;
      } catch (error) {
        console.error(`[twining] Failed to process ${label} (skipping):`, error);
      }
    }

    fs.rmSync(swapPath, { force: true });
    return processed;
  }
}
