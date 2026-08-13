/**
 * Semantic search with cosine similarity and keyword fallback.
 * Uses embedder for vector search, falls back to term-frequency
 * keyword search when ONNX is unavailable.
 */
import type { Embedder } from "./embedder.js";
import { blackboardEmbedText, decisionEmbedText } from "./embed-text.js";
import type { IIndexManager } from "../storage/interfaces.js";
import type { BlackboardEntry, Decision } from "../utils/types.js";

export interface BlackboardSearchResult {
  entry: BlackboardEntry;
  relevance: number;
}

export interface DecisionSearchResult {
  decision: Decision;
  relevance: number;
}

export interface SearchResults<T> {
  results: T[];
  /**
   * Pre-slice match count — never capped by limit (field D9). Membership is
   * tested on RAW scores, before any status de-boost: semantic mode counts
   * raw cosine >= SEARCH_NOISE_FLOOR (every embedded item gets a score, so
   * an unfloored count would equal the corpus size; noise sits ~0.26-0.28);
   * keyword mode counts every literal term hit (score > 0 — TF scores are a
   * different scale and a literal hit is never noise). The results page
   * itself is NOT floored — it stays a ranked page.
   */
  total_matched: number;
  fallback_mode: boolean;
}

/**
 * Relevance below this is indistinguishable from noise (measured ~0.26-0.28
 * cosine for nonsense queries on MiniLM). Used for total_matched counting
 * here and for assemble's semantic-admission floor.
 */
export const SEARCH_NOISE_FLOOR = 0.3;

// Retired decisions stay searchable (their status is in the result row) but a
// superseded original must not outrank its own amendment on raw similarity —
// originals state the thing more plainly than corrections do, so without this
// the top hit is biased toward the stale answer (field D9).
const RETIRED_STATUS_DEBOOST = 0.75;
const RETIRED_STATUSES = new Set(["superseded", "overridden", "archived"]);

export class SearchEngine {
  private readonly embedder: Embedder;
  private readonly indexManager: IIndexManager;

  constructor(embedder: Embedder, indexManager: IIndexManager) {
    this.embedder = embedder;
    this.indexManager = indexManager;
  }

  /** Search blackboard entries by semantic similarity or keyword fallback. */
  async searchBlackboard(
    query: string,
    entries: BlackboardEntry[],
    options?: { entry_types?: string[]; limit?: number },
  ): Promise<SearchResults<BlackboardSearchResult>> {
    const limit = options?.limit ?? 10;
    let filtered = entries;

    // Apply type filter
    if (options?.entry_types && options.entry_types.length > 0) {
      filtered = filtered.filter((e) =>
        options.entry_types!.includes(e.entry_type),
      );
    }

    if (filtered.length === 0) {
      return {
        results: [],
        total_matched: 0,
        fallback_mode: this.embedder.isFallbackMode(),
      };
    }

    // Try semantic search first
    if (!this.embedder.isFallbackMode()) {
      const queryVector = await this.embedder.embed(query);
      if (queryVector) {
        const index = await this.indexManager.load("blackboard");
        const vectorMap = new Map(
          index.entries.map((e) => [e.id, e.vector]),
        );

        const scored: BlackboardSearchResult[] = [];
        let matched = 0;
        for (const entry of filtered) {
          const entryVector = vectorMap.get(entry.id);
          if (entryVector) {
            const relevance = cosineSimilarity(queryVector, entryVector);
            if (relevance >= SEARCH_NOISE_FLOOR) matched++;
            scored.push({ entry, relevance });
          } else {
            // Entry has no embedding — use keyword as individual fallback
            const text = blackboardEmbedText(entry);
            const kwResults = keywordSearch(
              query,
              [{ id: entry.id, text }],
              1,
            );
            const score = kwResults[0]?.score ?? 0;
            if (score > 0) {
              matched++; // A literal term hit is a match regardless of scale.
              scored.push({ entry, relevance: score * 0.5 }); // Discount keyword scores
            }
          }
        }

        scored.sort((a, b) => b.relevance - a.relevance);
        return {
          results: scored.slice(0, limit),
          total_matched: matched,
          fallback_mode: false,
        };
      }
    }

    // Keyword fallback — pass the full population so total_matched is a real
    // count, not page occupancy; slice to limit only at the end.
    const items = filtered.map((e) => ({
      id: e.id,
      text: blackboardEmbedText(e),
    }));
    const kwResults = keywordSearch(query, items, filtered.length);
    const idToScore = new Map(kwResults.map((r) => [r.id, r.score]));

    const results: BlackboardSearchResult[] = [];
    for (const entry of filtered) {
      const score = idToScore.get(entry.id);
      if (score !== undefined && score > 0) {
        results.push({ entry, relevance: score });
      }
    }
    results.sort((a, b) => b.relevance - a.relevance);

    return {
      results: results.slice(0, limit),
      total_matched: results.length,
      fallback_mode: true,
    };
  }

  /** Search decisions by semantic similarity or keyword fallback. */
  async searchDecisions(
    query: string,
    decisions: Decision[],
    options?: { limit?: number },
  ): Promise<SearchResults<DecisionSearchResult>> {
    const limit = options?.limit ?? 10;

    if (decisions.length === 0) {
      return {
        results: [],
        total_matched: 0,
        fallback_mode: this.embedder.isFallbackMode(),
      };
    }

    // Ordering-only de-boost: membership (total_matched) always tests RAW
    // scores. Applied only to positive relevance — multiplying a negative
    // cosine by 0.75 would RAISE it, inverting the intended demotion.
    const deboost = (d: Decision, relevance: number): number =>
      RETIRED_STATUSES.has(d.status) && relevance > 0
        ? relevance * RETIRED_STATUS_DEBOOST
        : relevance;

    // Try semantic search first
    if (!this.embedder.isFallbackMode()) {
      const queryVector = await this.embedder.embed(query);
      if (queryVector) {
        const index = await this.indexManager.load("decisions");
        const vectorMap = new Map(
          index.entries.map((e) => [e.id, e.vector]),
        );

        const scored: DecisionSearchResult[] = [];
        let matched = 0;
        for (const decision of decisions) {
          const decisionVector = vectorMap.get(decision.id);
          if (decisionVector) {
            const raw = cosineSimilarity(queryVector, decisionVector);
            if (raw >= SEARCH_NOISE_FLOOR) matched++;
            scored.push({ decision, relevance: deboost(decision, raw) });
          } else {
            const text = decisionEmbedText(decision);
            const kwResults = keywordSearch(
              query,
              [{ id: decision.id, text }],
              1,
            );
            const score = kwResults[0]?.score ?? 0;
            if (score > 0) {
              matched++; // Literal term hit — a match regardless of scale.
              scored.push({
                decision,
                relevance: deboost(decision, score * 0.5),
              });
            }
          }
        }

        scored.sort((a, b) => b.relevance - a.relevance);
        return {
          results: scored.slice(0, limit),
          total_matched: matched,
          fallback_mode: false,
        };
      }
    }

    // Keyword fallback — full population, slice at the end (see searchBlackboard).
    const items = decisions.map((d) => ({
      id: d.id,
      text: decisionEmbedText(d),
    }));
    const kwResults = keywordSearch(query, items, decisions.length);
    const idToScore = new Map(kwResults.map((r) => [r.id, r.score]));

    const results: DecisionSearchResult[] = [];
    for (const decision of decisions) {
      const score = idToScore.get(decision.id);
      if (score !== undefined && score > 0) {
        results.push({ decision, relevance: deboost(decision, score) });
      }
    }
    results.sort((a, b) => b.relevance - a.relevance);

    return {
      results: results.slice(0, limit),
      total_matched: results.length,
      fallback_mode: true,
    };
  }
}

/**
 * Cosine similarity for pre-normalized vectors (dot product).
 * Since all-MiniLM-L6-v2 outputs normalized vectors, cosine similarity
 * simplifies to the dot product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    console.error(
      `[twining] Cosine similarity dimension mismatch: ${a.length} vs ${b.length}. Returning 0.`,
    );
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

/**
 * Term-frequency based keyword search for fallback mode.
 * Scores each item by how many query terms appear and how often.
 */
export function keywordSearch(
  query: string,
  items: { id: string; text: string }[],
  limit: number,
): { id: string; score: number }[] {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (queryTerms.length === 0) return [];

  const results: { id: string; score: number }[] = [];

  for (const item of items) {
    const textLower = item.text.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (textLower.includes(term)) {
        // Count occurrences with diminishing returns
        const parts = textLower.split(term);
        const matches = parts.length - 1;
        score += Math.log(1 + matches);
      }
    }

    // Normalize by number of query terms
    const normalizedScore = score / queryTerms.length;

    if (normalizedScore > 0) {
      results.push({ id: item.id, score: normalizedScore });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
