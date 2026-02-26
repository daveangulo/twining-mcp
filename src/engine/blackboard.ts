/**
 * Blackboard business logic.
 * Validates input, applies defaults, delegates to BlackboardStore.
 * Generates embeddings on post (Phase 2) with graceful fallback.
 */
import { BlackboardStore } from "../storage/blackboard-store.js";
import { ENTRY_TYPES } from "../utils/types.js";
import type { BlackboardEntry, EntryType, TwiningConfig } from "../utils/types.js";
import { TwiningError } from "../utils/errors.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { IndexManager } from "../embeddings/index-manager.js";
import type { SearchEngine, BlackboardSearchResult } from "../embeddings/search.js";
import type { Archiver } from "./archiver.js";

export class BlackboardEngine {
  private readonly store: BlackboardStore;
  private readonly embedder: Embedder | null;
  private readonly indexManager: IndexManager | null;
  private readonly searchEngine: SearchEngine | null;
  private archiver: Archiver | null = null;
  private archiveThreshold: number | null = null;

  constructor(
    store: BlackboardStore,
    embedder?: Embedder | null,
    indexManager?: IndexManager | null,
    searchEngine?: SearchEngine | null,
  ) {
    this.store = store;
    this.embedder = embedder ?? null;
    this.indexManager = indexManager ?? null;
    this.searchEngine = searchEngine ?? null;
  }

  /** Inject archiver for threshold-based auto-archiving (spec §6.1.3). */
  setArchiver(archiver: Archiver, config: TwiningConfig): void {
    this.archiver = archiver;
    this.archiveThreshold = config.archive.max_blackboard_entries_before_archive;
  }

  /** Post a new blackboard entry with validation and defaults. */
  async post(input: {
    entry_type: string;
    summary: string;
    detail?: string;
    tags?: string[];
    scope?: string;
    relates_to?: string[];
    agent_id?: string;
    _internal?: boolean;
  }): Promise<{ id: string; timestamp: string }> {
    // Validate entry_type
    if (!ENTRY_TYPES.includes(input.entry_type as EntryType)) {
      throw new TwiningError(
        `Invalid entry_type "${input.entry_type}". Must be one of: ${ENTRY_TYPES.join(", ")}`,
        "INVALID_INPUT",
      );
    }

    // Reject direct decision posts — agents must use twining_decide for rationale capture
    if (input.entry_type === "decision" && !input._internal) {
      throw new TwiningError(
        `Use twining_decide to record decisions (ensures rationale, graph linkage, and conflict detection). twining_post does not accept entry_type "decision".`,
        "INVALID_INPUT",
      );
    }

    // Validate summary length
    if (!input.summary || input.summary.length === 0) {
      throw new TwiningError("summary is required", "INVALID_INPUT");
    }
    if (input.summary.length > 200) {
      throw new TwiningError(
        "summary must be at most 200 characters",
        "INVALID_INPUT",
      );
    }

    const entry = await this.store.append({
      entry_type: input.entry_type as EntryType,
      summary: input.summary,
      detail: input.detail ?? "",
      tags: input.tags ?? [],
      scope: input.scope ?? "project",
      relates_to: input.relates_to,
      agent_id: input.agent_id ?? "main",
    });

    // Generate embedding (Phase 2) — never let embedding failure prevent the post
    if (this.embedder && this.indexManager) {
      try {
        const text = entry.summary + " " + entry.detail;
        const vector = await this.embedder.embed(text);
        if (vector) {
          await this.indexManager.addEntry("blackboard", entry.id, vector);
        }
      } catch (error) {
        // Silent failure — embedding is best-effort
        console.error("[twining] Embedding generation failed (non-fatal):", error);
      }
    }

    // Auto-archive if threshold exceeded (fire-and-forget, non-fatal) — spec §6.1.3
    if (this.archiver && this.archiveThreshold) {
      const { total_count } = await this.store.read();
      if (total_count >= this.archiveThreshold) {
        this.archiver.archive({ summarize: true }).catch((err) => {
          console.error("[twining] Auto-archive failed (non-fatal):", err);
        });
      }
    }

    return { id: entry.id, timestamp: entry.timestamp };
  }

  /** Read blackboard entries with optional filters. */
  async read(filters?: {
    entry_types?: string[];
    tags?: string[];
    scope?: string;
    since?: string;
    limit?: number;
  }): Promise<{ entries: BlackboardEntry[]; total_count: number }> {
    return this.store.read({
      entry_types: filters?.entry_types,
      tags: filters?.tags,
      scope: filters?.scope,
      since: filters?.since,
      limit: filters?.limit ?? 50,
    });
  }

  /** Semantic search across blackboard entries. Default limit: 10. */
  async query(
    query: string,
    options?: { entry_types?: string[]; limit?: number },
  ): Promise<{
    results: BlackboardSearchResult[];
    fallback_mode: boolean;
  }> {
    if (!this.searchEngine) {
      return { results: [], fallback_mode: true };
    }

    const { entries } = await this.store.read();
    const limit = options?.limit ?? 10;

    return this.searchEngine.searchBlackboard(query, entries, {
      entry_types: options?.entry_types,
      limit,
    });
  }

  /** Get the N most recent entries, optionally filtered by type. */
  async recent(
    n?: number,
    entry_types?: string[],
  ): Promise<{ entries: BlackboardEntry[] }> {
    const entries = await this.store.recent(n, entry_types);
    return { entries };
  }

  /** Dismiss (remove) blackboard entries by ID. Cleans up embeddings if available. */
  async dismiss(ids: string[]): Promise<{ dismissed: string[]; not_found: string[] }> {
    if (!ids || ids.length === 0) {
      throw new TwiningError("At least one entry ID is required", "INVALID_INPUT");
    }

    const result = await this.store.dismiss(ids);

    // Clean up embeddings for dismissed entries (best-effort)
    if (this.indexManager && result.dismissed.length > 0) {
      try {
        await this.indexManager.removeEntries("blackboard", result.dismissed);
      } catch {
        // Best-effort — don't fail dismiss if embedding cleanup fails
      }
    }

    return result;
  }
}
