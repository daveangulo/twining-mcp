/**
 * Live record sync (FOUNDATION-PLAN W2.3 phase 2).
 *
 * Phase 1 ingests the export tree at startup only — a branch switch, pull,
 * or merge mid-session leaves the database stale until the next restart.
 * This manager closes that gap with a lazy probe on tool dispatch: before a
 * tool runs, compare the repo's HEAD sha against the sha at the last ingest;
 * if it moved, re-run ingest (idempotent, upsert-by-ULID) and schedule an
 * embedding reconcile. Every git operation that can change the checked-out
 * records/ tree — checkout, pull, merge, rebase — moves HEAD, so the sha is
 * a sufficient trigger; manual edits to records/ without a git op are out
 * of scope (startup ingest catches them next session).
 *
 * Same snapshot-and-diff idea as engine/branch-watcher.ts (the housekeeping
 * deleted-branch sweep), but deliberately a separate module: that watcher's
 * trigger is housekeeping runs and its signal is branch deletion; this one
 * rides tool dispatch and watches HEAD movement.
 *
 * Why not fs.watch on records/? A watcher fires on our own exports (every
 * write), needs debounce and lifecycle management in a long-lived stdio
 * process, and buys nothing the acceptance criterion needs: "assemble sees
 * pulled records" — and assemble is a tool call, so probing at dispatch is
 * exactly on time. The probe is TTL-throttled so tool bursts cost one
 * `git rev-parse` (~1ms) per window, and zero git work happens while idle.
 */
import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Embedder } from "../../embeddings/embedder.js";
import type { SqliteDatabase } from "../sqlite/db.js";
import { ingestRecords } from "./record-ingest.js";
import { reconcileEmbeddings } from "./embedding-reconcile.js";

const DEFAULT_PROBE_TTL_MS = 5_000;

export class RecordSyncManager {
  private embedder: Embedder | null = null;
  private lastProbeAt = 0;
  private lastHeadSha: string | undefined;
  /** Serializes reconcile passes — at most one in flight, one queued. */
  private reconcileChain: Promise<void> = Promise.resolve();
  private reconcileQueued = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly twiningDir: string,
    private readonly projectRoot: string,
    private readonly probeTtlMs: number = DEFAULT_PROBE_TTL_MS,
  ) {
    // Snapshot taken at construction — backend-factory creates the manager
    // right after the startup ingest, so "HEAD at last ingest" holds.
    this.lastHeadSha = this.headSha();
  }

  /** The reconciler needs the embedder, which is created after the stores. */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  /**
   * TTL-gated staleness probe, called before tool dispatch. Synchronous on
   * purpose: ingest must complete before the tool reads, or an assemble
   * racing a branch switch would still see the old branch's records.
   */
  maybeResync(): void {
    const now = Date.now();
    if (now - this.lastProbeAt < this.probeTtlMs) return;
    this.lastProbeAt = now;

    const sha = this.headSha();
    if (sha === this.lastHeadSha) return;
    this.lastHeadSha = sha;

    try {
      const stats = ingestRecords(this.db, this.twiningDir);
      if (stats.inserted || stats.updated || stats.deleted) {
        console.error(
          `[twining] HEAD moved — re-ingested records: +${stats.inserted} ~${stats.updated} -${stats.deleted}` +
            (stats.skipped ? ` (${stats.skipped} unparseable skipped)` : "") +
            (stats.lifecycle_reverts
              ? ` (${stats.lifecycle_reverts} lifecycle revert(s) — see preceding lines)`
              : ""),
        );
        this.scheduleReconcile();
      }
    } catch (err) {
      console.error(
        "[twining] Record re-ingest failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Run an embedding reconcile asynchronously (fire-and-forget, serialized).
   * Also called once at startup: phase-1 ingest never embedded what it
   * inserted, so records that arrived while the server was down get their
   * vectors here.
   */
  scheduleReconcile(): void {
    if (!this.embedder || this.reconcileQueued) return;
    const embedder = this.embedder;
    this.reconcileQueued = true;
    this.reconcileChain = this.reconcileChain.then(async () => {
      this.reconcileQueued = false;
      try {
        const stats = await reconcileEmbeddings(this.db, embedder);
        if (stats.embedded || stats.backfilled || stats.deleted) {
          console.error(
            `[twining] Embeddings reconciled: +${stats.embedded} embedded, ` +
              `${stats.backfilled} backfilled, -${stats.deleted} orphans` +
              (stats.pending ? ` (${stats.pending} pending — no model)` : ""),
          );
        }
      } catch (err) {
        console.error(
          "[twining] Embedding reconcile failed (non-fatal):",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  }

  /** Await in-flight reconciles — test hook. */
  async settle(): Promise<void> {
    await this.reconcileChain;
  }

  private headSha(): string | undefined {
    try {
      const out = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.projectRoot,
        encoding: "utf-8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out || undefined;
    } catch {
      return undefined; // non-git dir, git absent, or empty repo
    }
  }
}

/**
 * Patch registerTool so every tool call probes for git-driven staleness
 * first — the same invisible-to-tools patching instrumented-server uses.
 */
export function attachSyncProbe(
  server: McpServer,
  manager: RecordSyncManager,
): void {
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = function (
    name: string,
    config: unknown,
    callback: (...cbArgs: unknown[]) => unknown,
  ) {
    const wrapped = (...cbArgs: unknown[]) => {
      try {
        manager.maybeResync();
      } catch {
        // The probe must never break a tool call.
      }
      return callback(...cbArgs);
    };
    return originalRegisterTool(name, config as never, wrapped as never);
  } as typeof server.registerTool;
}
