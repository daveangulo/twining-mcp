/**
 * Blackboard business logic.
 * Validates input, applies defaults, delegates to BlackboardStore.
 */
import { BlackboardStore } from "../storage/blackboard-store.js";
import { ENTRY_TYPES } from "../utils/types.js";
import type { BlackboardEntry, EntryType } from "../utils/types.js";
import { TwiningError } from "../utils/errors.js";

export class BlackboardEngine {
  private readonly store: BlackboardStore;

  constructor(store: BlackboardStore) {
    this.store = store;
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
  }): Promise<{ id: string; timestamp: string }> {
    // Validate entry_type
    if (!ENTRY_TYPES.includes(input.entry_type as EntryType)) {
      throw new TwiningError(
        `Invalid entry_type "${input.entry_type}". Must be one of: ${ENTRY_TYPES.join(", ")}`,
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

  /** Get the N most recent entries, optionally filtered by type. */
  async recent(
    n?: number,
    entry_types?: string[],
  ): Promise<{ entries: BlackboardEntry[] }> {
    const entries = await this.store.recent(n, entry_types);
    return { entries };
  }
}
