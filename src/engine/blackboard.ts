/**
 * Blackboard business logic.
 * Validates input, applies defaults, delegates to IBlackboardStore.
 * Generates embeddings on post (Phase 2) with graceful fallback.
 */
import { ENTRY_TYPES } from "../utils/types.js";
import type { BlackboardEntry, EntryType, TwiningConfig } from "../utils/types.js";
import { TwiningError } from "../utils/errors.js";
import { captureProvenance } from "../utils/provenance.js";
import type { Embedder } from "../embeddings/embedder.js";
import { blackboardEmbedText, embedContentHash } from "../embeddings/embed-text.js";
import { COUNT_SEMANTICS, type SearchEngine, type BlackboardSearchResult } from "../embeddings/search.js";
import type { Archiver } from "./archiver.js";
import { NO_AGE_CUTOFF, partitionArchivable } from "./archiver.js";
import { computeResolvedIds } from "./resolution.js";
import type { GraphAutoPopulator } from "./graph-auto-populator.js";
import type { IAgentStore, IBlackboardStore, IIndexManager } from "../storage/interfaces.js";

export class BlackboardEngine {
  /**
   * IDs of entries posted through THIS engine instance — i.e. by the calling
   * session, since the stdio server is one process per session. The exact
   * self-authorship signal for assemble's lane marking (field D12): a
   * timestamp heuristic mislabels concurrent sessions sharing the store,
   * and agent_id is a role label, not an identity.
   */
  readonly sessionPostIds = new Set<string>();
  private readonly store: IBlackboardStore;
  private readonly embedder: Embedder | null;
  private readonly indexManager: IIndexManager | null;
  private readonly searchEngine: SearchEngine | null;
  private readonly projectRoot: string | null;
  private archiver: Archiver | null = null;
  private archiveThreshold: number | null = null;
  private archiveRetain = 0;
  private graphPopulator: GraphAutoPopulator | null = null;
  private agentStore: IAgentStore | null = null;

  constructor(
    store: IBlackboardStore,
    embedder?: Embedder | null,
    indexManager?: IIndexManager | null,
    searchEngine?: SearchEngine | null,
    projectRoot?: string | null,
  ) {
    this.store = store;
    this.embedder = embedder ?? null;
    this.indexManager = indexManager ?? null;
    this.searchEngine = searchEngine ?? null;
    this.projectRoot = projectRoot ?? null;
  }

  /** Inject archiver for threshold-based auto-archiving (spec §6.1.3). */
  setArchiver(archiver: Archiver, config: TwiningConfig): void {
    this.archiver = archiver;
    this.archiveThreshold = config.archive.max_blackboard_entries_before_archive;
    this.archiveRetain = config.archive.retain_recent ?? 0;
  }

  /** Inject graph auto-populator for relation extraction from posts. */
  setGraphPopulator(populator: GraphAutoPopulator): void {
    this.graphPopulator = populator;
  }

  /** Inject agent store for registry auto-touch on writes (#32). */
  setAgentStore(agentStore: IAgentStore): void {
    this.agentStore = agentStore;
  }

  /**
   * Best-effort registry touch for a writing agent (#32). Fire-and-forget:
   * a registry failure must never fail the write. "unknown" is skipped —
   * a shared record for identity-less callers would aggregate unrelated
   * agents into noise (same call as the subagent-stop hook's silence).
   */
  touchAgent(agentId: string | undefined): void {
    if (!this.agentStore) return;
    const id = agentId ?? "main";
    if (!id || id === "unknown") return;
    Promise.resolve(this.agentStore.touch(id)).catch(() => {
      // Non-fatal — registry is observability, not correctness.
    });
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
    origin?: "narration" | "discovery";
    // Bypasses the entry_type "decision" rejection. No production callers
    // since issue #30 removed the decision cross-post; kept so tests can
    // simulate legacy mirror entries still present on field blackboards.
    _internal?: boolean;
    _skipAutoArchive?: boolean;
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
      ...(input.origin ? { origin: input.origin } : {}),
      provenance: captureProvenance(this.projectRoot),
    });
    this.sessionPostIds.add(entry.id);

    // Registry auto-touch (#32): every write marks its author as a
    // participant so the registry reflects who actually worked here.
    this.touchAgent(input.agent_id);

    // Auto-populate graph with scope/relation entities (best-effort)
    if (this.graphPopulator) {
      await this.graphPopulator.onPost(entry);
    }

    // Generate embedding (Phase 2) — never let embedding failure prevent the post
    if (this.embedder && this.indexManager) {
      try {
        const text = blackboardEmbedText(entry);
        const vector = await this.embedder.embed(text);
        if (vector) {
          await this.indexManager.addEntry(
            "blackboard",
            entry.id,
            vector,
            embedContentHash(text),
          );
        }
      } catch (error) {
        // Silent failure — embedding is best-effort
        console.error("[twining] Embedding generation failed (non-fatal):", error);
      }
    }

    // Auto-archive if threshold exceeded (fire-and-forget, non-fatal) — spec §6.1.3
    // The count IS the sweep's own partition (partitionArchivable): any
    // drift between what the trigger counts and what the sweep archives is
    // how the #35 feedback loop happened (counted-but-exempt entries kept
    // the count permanently over threshold, firing on every post). The old
    // ad-hoc predicate — no decisions, no "archive"-tagged summary posts,
    // no unresolved need/warning — is subsumed: exempt classes never enter
    // to_archive, and anything counted WILL be archived by the same
    // partition, so re-arming is impossible by construction. The far-future
    // cutoff mirrors the old no-age-filter count semantics (a same-
    // millisecond post must not dodge the count); retention (D4) bounds the
    // sweep to all but the newest retain_recent entries.
    if (this.archiver && this.archiveThreshold && !input._skipAutoArchive) {
      const { entries } = await this.store.read();
      const resolvedIds = computeResolvedIds(entries);
      const { to_archive } = partitionArchivable(entries, resolvedIds, {
        before: NO_AGE_CUTOFF,
        retain: this.archiveRetain,
      });
      if (to_archive.length >= this.archiveThreshold) {
        // Same NO_AGE_CUTOFF as the count above — a cutoff=now sweep would
        // exclude future-stamped entries the count included, re-firing on
        // every post while archiving nothing (clock-skew #35 variant).
        this.archiver
          .archive({
            summarize: true,
            retain: this.archiveRetain,
            before: NO_AGE_CUTOFF,
          })
          .catch((err) => {
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
    /** Pre-slice count of matches above the noise floor (field D9). */
    total_matched: number;
    /** Which generation of count semantics this response carries (ask 2). */
    count_semantics: string;
    fallback_mode: boolean;
  }> {
    if (!this.searchEngine) {
      return {
        results: [],
        total_matched: 0,
        count_semantics: COUNT_SEMANTICS,
        fallback_mode: true,
      };
    }

    const { entries } = await this.store.read();
    const limit = options?.limit ?? 10;

    const searched = await this.searchEngine.searchBlackboard(query, entries, {
      entry_types: options?.entry_types,
      limit,
    });
    return { ...searched, count_semantics: COUNT_SEMANTICS };
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

  /**
   * Mark entries resolved (D2) — the record-preserving exit from the open
   * lane. Embeddings are untouched: the entry's text is unchanged and
   * resolved entries remain searchable history.
   */
  async resolve(
    ids: string[],
    opts?: { agent_id?: string; note?: string },
  ): Promise<{ resolved: string[]; not_found: string[] }> {
    if (!ids || ids.length === 0) {
      throw new TwiningError("At least one entry ID is required", "INVALID_INPUT");
    }
    const result = await this.store.resolve(ids, {
      by: opts?.agent_id,
      note: opts?.note,
    });
    this.touchAgent(opts?.agent_id);
    return result;
  }
}
