/**
 * Semantic search with cosine similarity and keyword fallback.
 * Uses embedder for vector search, falls back to term-frequency
 * keyword search when ONNX is unavailable.
 */
import type { Embedder } from "./embedder.js";
import type { IndexManager } from "./index-manager.js";
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
  fallback_mode: boolean;
}

export class SearchEngine {
  private readonly embedder: Embedder;
  private readonly indexManager: IndexManager;

  constructor(embedder: Embedder, indexManager: IndexManager) {
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
      return { results: [], fallback_mode: this.embedder.isFallbackMode() };
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
        for (const entry of filtered) {
          const entryVector = vectorMap.get(entry.id);
          if (entryVector) {
            const relevance = cosineSimilarity(queryVector, entryVector);
            scored.push({ entry, relevance });
          } else {
            // Entry has no embedding — use keyword as individual fallback
            const text = entry.summary + " " + entry.detail;
            const kwResults = keywordSearch(
              query,
              [{ id: entry.id, text }],
              1,
            );
            const score = kwResults[0]?.score ?? 0;
            if (score > 0) {
              scored.push({ entry, relevance: score * 0.5 }); // Discount keyword scores
            }
          }
        }

        scored.sort((a, b) => b.relevance - a.relevance);
        return {
          results: scored.slice(0, limit),
          fallback_mode: false,
        };
      }
    }

    // Keyword fallback
    const items = filtered.map((e) => ({
      id: e.id,
      text: e.summary + " " + e.detail,
    }));
    const kwResults = keywordSearch(query, items, limit);
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
      return { results: [], fallback_mode: this.embedder.isFallbackMode() };
    }

    // Try semantic search first
    if (!this.embedder.isFallbackMode()) {
      const queryVector = await this.embedder.embed(query);
      if (queryVector) {
        const index = await this.indexManager.load("decisions");
        const vectorMap = new Map(
          index.entries.map((e) => [e.id, e.vector]),
        );

        const scored: DecisionSearchResult[] = [];
        for (const decision of decisions) {
          const decisionVector = vectorMap.get(decision.id);
          if (decisionVector) {
            const relevance = cosineSimilarity(queryVector, decisionVector);
            scored.push({ decision, relevance });
          } else {
            const text =
              decision.summary + " " + decision.rationale + " " + decision.context;
            const kwResults = keywordSearch(
              query,
              [{ id: decision.id, text }],
              1,
            );
            const score = kwResults[0]?.score ?? 0;
            if (score > 0) {
              scored.push({ decision, relevance: score * 0.5 });
            }
          }
        }

        scored.sort((a, b) => b.relevance - a.relevance);
        return {
          results: scored.slice(0, limit),
          fallback_mode: false,
        };
      }
    }

    // Keyword fallback
    const items = decisions.map((d) => ({
      id: d.id,
      text: d.summary + " " + d.rationale + " " + d.context,
    }));
    const kwResults = keywordSearch(query, items, limit);
    const idToScore = new Map(kwResults.map((r) => [r.id, r.score]));

    const results: DecisionSearchResult[] = [];
    for (const decision of decisions) {
      const score = idToScore.get(decision.id);
      if (score !== undefined && score > 0) {
        results.push({ decision, relevance: score });
      }
    }
    results.sort((a, b) => b.relevance - a.relevance);

    return {
      results: results.slice(0, limit),
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
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
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
