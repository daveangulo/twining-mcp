# Phase 2: Intelligence - Research

**Researched:** 2026-02-16
**Domain:** Embeddings, semantic search, and context assembly for MCP server
**Confidence:** HIGH

## Summary

Phase 2 adds semantic search and token-budgeted context assembly to the existing Twining MCP server. The core technical challenge is integrating local ONNX-based embeddings (all-MiniLM-L6-v2 via `@huggingface/transformers`) with lazy loading and graceful keyword fallback, then building a context assembler that scores and selects relevant content within token budgets.

The `@huggingface/transformers` package (v3.x) provides a clean `pipeline('feature-extraction', ...)` API that handles ONNX model loading, tokenization, mean pooling, and normalization in a single call. The model produces 384-dimensional vectors suitable for brute-force cosine similarity search at the scale Twining operates (<10k entries). The library automatically downloads and caches models on first use, making lazy loading natural.

**Primary recommendation:** Use `@huggingface/transformers` (v3.x) with the singleton/lazy pattern for the embedder. Store embedding indexes as JSON. Implement keyword fallback using simple term-frequency scoring. Build the context assembler with weighted multi-signal scoring (recency, relevance, confidence, warning boost).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Default result count: 10 results per search query
- Tool design: Follow TWINING-DESIGN-SPEC.md for tool structure and naming
- Claude's discretion: relevance threshold strategy (hard cutoff vs always fill), whether to expose similarity scores

### Claude's Discretion
- Context budget strategy: budget allocation approach, priority hints, budget range assumptions, overflow metadata
- Fallback behavior: flagging keyword fallback mode, keyword search algorithm, ONNX recovery strategy, force-keyword mode
- Summary & changelog: what_changed granularity, live generation vs pre-computed, quantitative stats

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EMBD-01 | Semantic search uses local ONNX embeddings (all-MiniLM-L6-v2, 384 dimensions) | `@huggingface/transformers` provides `Xenova/all-MiniLM-L6-v2` via ONNX with 384-dim output |
| EMBD-02 | Embedding model is lazy-loaded on first use, not at server startup | Singleton pattern with `pipeline()` — only instantiated on first embedding operation |
| EMBD-03 | If ONNX fails to load, server falls back to keyword-based search without crashing | Try/catch around pipeline init, fallback to term-frequency keyword search |
| EMBD-04 | Embeddings are generated for every blackboard entry and decision | Hook into `BlackboardEngine.post()` and `DecisionEngine.decide()` to generate on write |
| BLKB-03 | Agent can search blackboard entries by natural language query (semantic search) | `twining_query` tool uses embedding cosine similarity with keyword fallback |
| CTXA-01 | Agent can request tailored context for a task+scope within token budget | Context assembler with weighted scoring, token estimation at 4 chars/token |
| CTXA-02 | Agent can get high-level summary of project or scope state | `twining_summarize` aggregates counts + generates narrative from recent activity |
| CTXA-03 | Agent can see what changed since a given timestamp | `twining_what_changed` filters entries and decisions by timestamp |
| CTXA-04 | Context assembly uses weighted scoring: recency, relevance, decision confidence, warning boost | Multi-signal scoring with configurable weights from config.yml |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @huggingface/transformers | ^3.x (latest stable) | Feature extraction pipeline for embeddings | Official HuggingFace JS library; handles ONNX model loading, tokenization, pooling, normalization in single API |
| onnxruntime-node | (peer dep of transformers) | ONNX model inference runtime for Node.js | Auto-selected by transformers.js when running in Node.js environment |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (no additional libraries needed) | - | - | All other functionality (cosine similarity, keyword search, context assembly) is straightforward enough to implement directly |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @huggingface/transformers | Raw onnxruntime-node + manual tokenizer | More control but must handle tokenization, pooling, normalization manually — significant complexity for no benefit |
| Brute-force cosine search | Vector DB (e.g., LanceDB) | Unnecessary for <10k entries; adds dependency and complexity |
| Simple term-frequency fallback | Full BM25 implementation | BM25 is better for varied document lengths but overkill for short summaries/rationales |

**Installation:**
```bash
npm install @huggingface/transformers
```

Note: `onnxruntime-node` is automatically resolved as a peer dependency by `@huggingface/transformers` when running in Node.js. No separate install needed.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── embeddings/
│   ├── embedder.ts           # Singleton lazy-loaded pipeline wrapper
│   ├── index-manager.ts      # Embedding index CRUD (JSON-based)
│   └── search.ts             # Cosine similarity + keyword fallback
├── engine/
│   ├── context-assembler.ts  # Token-budgeted context assembly
│   ├── blackboard.ts         # (existing — add embedding hook)
│   └── decisions.ts          # (existing — add embedding hook)
└── tools/
    └── context-tools.ts      # twining_query, twining_assemble, twining_summarize, twining_what_changed
```

### Pattern 1: Lazy-Loaded Singleton Embedder
**What:** The embedding pipeline is created once on first use and reused for all subsequent calls. If initialization fails, the embedder permanently falls back to keyword mode.
**When to use:** Always — this is the core pattern for the embedder.
**Example:**
```typescript
// Source: HuggingFace transformers.js Node.js tutorial
import { pipeline, env } from "@huggingface/transformers";

class Embedder {
  private static instance: Embedder | null = null;
  private pipeline: any = null;
  private fallbackMode = false;
  private initPromise: Promise<void> | null = null;

  static async getInstance(): Promise<Embedder> {
    if (!Embedder.instance) {
      Embedder.instance = new Embedder();
    }
    return Embedder.instance;
  }

  async embed(text: string): Promise<number[] | null> {
    if (this.fallbackMode) return null;

    if (!this.pipeline) {
      await this.initialize();
    }

    if (this.fallbackMode) return null;

    const output = await this.pipeline(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  }

  private async initialize(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      try {
        env.cacheDir = ".twining/models";
        this.pipeline = await pipeline(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2"
        );
      } catch (error) {
        console.error("ONNX embedding init failed, using keyword fallback:", error);
        this.fallbackMode = true;
      }
    })();

    await this.initPromise;
  }

  isFallbackMode(): boolean {
    return this.fallbackMode;
  }
}
```

### Pattern 2: Embedding Index as JSON
**What:** Store embeddings as a JSON file mapping entry/decision IDs to their vectors.
**When to use:** For all embedding storage — matches Twining's file-native design.
**Example:**
```typescript
// Spec section 5.3
interface EmbeddingIndex {
  model: string;           // "all-MiniLM-L6-v2"
  dimension: number;       // 384
  entries: {
    id: string;            // Reference to blackboard entry or decision
    vector: number[];      // 384-dimensional float array
  }[];
}
```

Two index files:
- `.twining/embeddings/blackboard.index` — blackboard entry embeddings
- `.twining/embeddings/decisions.index` — decision embeddings

### Pattern 3: Cosine Similarity with Pre-Normalized Vectors
**What:** Since all-MiniLM-L6-v2 outputs normalized vectors (when `normalize: true`), cosine similarity simplifies to a dot product.
**When to use:** Always — the model outputs normalized vectors by default.
**Example:**
```typescript
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// For normalized vectors, dotProduct IS cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  return dotProduct(a, b);
}
```

### Pattern 4: Multi-Signal Context Scoring
**What:** Score each candidate context item using weighted combination of signals.
**When to use:** In context-assembler.ts for ranking items before filling the token budget.
**Example:**
```typescript
// From spec section 5.5 and config.yml
function scoreItem(item: ScoredItem, queryVector: number[] | null, config: PriorityWeights): number {
  const recency = exponentialDecay(item.timestamp, halfLifeHours);
  const relevance = queryVector ? cosineSimilarity(queryVector, item.vector) : keywordScore(item);
  const confidence = item.confidence === "high" ? 1.0 : item.confidence === "medium" ? 0.6 : 0.3;
  const warningBoost = item.entryType === "warning" ? 1.0 : 0.0;

  return (
    config.recency * recency +
    config.relevance * relevance +
    config.decision_confidence * confidence +
    config.warning_boost * warningBoost
  );
}
```

### Anti-Patterns to Avoid
- **Loading embedder at server startup:** Must be lazy — server startup should never depend on ONNX
- **Blocking on embedding during post/decide:** Generate embeddings inline but catch errors silently; never let embedding failure prevent a write
- **Large embedding index in memory permanently:** Load index on search, not on startup; index is a few MB at most for <10k entries
- **Custom tokenizer implementation:** Use transformers.js pipeline which handles tokenization internally

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Text tokenization for embeddings | Custom WordPiece tokenizer | `@huggingface/transformers` pipeline | Tokenizer must match model training exactly; pipeline handles this |
| Mean pooling of token embeddings | Manual attention mask + averaging | `pipeline(..., { pooling: 'mean', normalize: true })` | The pipeline option handles this correctly and efficiently |
| ONNX model loading/inference | Raw `onnxruntime-node` session creation | `@huggingface/transformers` pipeline | Handles model download, caching, session creation, input/output tensors |
| Vector normalization | Manual L2 norm calculation | Pipeline `normalize: true` option | Already handled by the pipeline |

**Key insight:** `@huggingface/transformers` abstracts away the entire ONNX inference complexity. The pipeline API is the correct level of abstraction — going lower adds complexity with no benefit for this use case.

## Common Pitfalls

### Pitfall 1: ONNX Platform Incompatibility
**What goes wrong:** `onnxruntime-node` may not have pre-built binaries for all platforms (e.g., some ARM Linux distros).
**Why it happens:** Native binaries are platform-specific; ONNX Runtime has limited platform coverage.
**How to avoid:** The graceful fallback to keyword search is the primary mitigation. Catch all errors during embedder initialization and switch to fallback mode permanently.
**Warning signs:** Import errors, native module loading failures during `pipeline()` creation.

### Pitfall 2: Model Download on First Use
**What goes wrong:** First embedding call triggers a ~23MB model download from HuggingFace Hub, which may be slow or fail in air-gapped environments.
**Why it happens:** `@huggingface/transformers` downloads and caches models on first use.
**How to avoid:** Set `env.cacheDir` to `.twining/models/` so the cache is within the project. Document that first use requires internet access. The fallback mode handles offline environments.
**Warning signs:** Long first-use latency, timeout errors in CI/CD.

### Pitfall 3: all-MiniLM-L6-v2 Token Limit
**What goes wrong:** Text longer than ~128 tokens (good results) or 256 tokens (max) gets truncated silently, producing poor embeddings.
**Why it happens:** The model has a 256-token context window with best results at 128 tokens.
**How to avoid:** Embed `summary + " " + detail` as spec says (summaries are max 200 chars ≈ 50 tokens, well within limits). For decisions, embed `summary + " " + rationale + " " + context` — may be longer but the summary+rationale are the most important parts and appear first.
**Warning signs:** Search results that seem irrelevant despite good queries.

### Pitfall 4: Concurrent Embedding Index Writes
**What goes wrong:** Two agents writing to the embedding index simultaneously could corrupt it.
**Why it happens:** JSON file read-modify-write is not atomic.
**How to avoid:** Use the same `proper-lockfile` pattern already used in `DecisionStore` for all index writes.
**Warning signs:** Truncated or malformed JSON index files.

### Pitfall 5: Embedding Index Stale After Delete/Archive
**What goes wrong:** Embedding index references entries that no longer exist in the active blackboard.
**Why it happens:** Archive/delete doesn't clean up the embedding index.
**How to avoid:** When archiving, also remove archived entry IDs from the embedding index. The spec mentions "Rebuilds embedding index for remaining entries" in the archive process.
**Warning signs:** Search returning archived/deleted entries.

## Code Examples

### Creating the Feature Extraction Pipeline
```typescript
// Source: HuggingFace transformers.js docs + Node.js tutorial
import { pipeline, env } from "@huggingface/transformers";

// Configure cache directory within .twining/
env.cacheDir = path.join(twiningDir, "models");

// Create pipeline (downloads model on first call, ~23MB)
const extractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2"
);

// Generate embedding for a text
const output = await extractor("Agent decided to use JWT for auth", {
  pooling: "mean",
  normalize: true,
});

// Convert to plain number array (384 dimensions)
const vector: number[] = Array.from(output.data);
```

### Cosine Similarity Search (Brute Force)
```typescript
// For normalized vectors, dot product = cosine similarity
function search(
  queryVector: number[],
  index: EmbeddingIndex,
  limit: number = 10
): { id: string; score: number }[] {
  const results = index.entries.map((entry) => ({
    id: entry.id,
    score: dotProduct(queryVector, entry.vector),
  }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
```

### Simple Keyword Fallback Search
```typescript
// Term-frequency based keyword search for fallback mode
function keywordSearch(
  query: string,
  entries: { id: string; text: string }[],
  limit: number = 10
): { id: string; score: number }[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const results = entries.map((entry) => {
    const entryLower = entry.text.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (entryLower.includes(term)) {
        // Count occurrences, with diminishing returns
        const matches = entryLower.split(term).length - 1;
        score += Math.log(1 + matches);
      }
    }
    // Normalize by number of query terms
    return { id: entry.id, score: score / queryTerms.length };
  });

  return results
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

### Token Budget Filling
```typescript
// Fill token budget in priority order
function fillBudget<T extends { tokenEstimate: number }>(
  items: T[],
  budget: number
): T[] {
  const selected: T[] = [];
  let remaining = budget;

  for (const item of items) {
    if (item.tokenEstimate <= remaining) {
      selected.push(item);
      remaining -= item.tokenEstimate;
    }
    if (remaining <= 0) break;
  }

  return selected;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@xenova/transformers` (legacy package name) | `@huggingface/transformers` (official) | v3 release (2024) | Use the `@huggingface/transformers` package, not the old `@xenova/` namespace |
| onnxruntime-node manual usage | transformers.js pipeline abstraction | 2024+ | Pipeline handles all ONNX complexity; direct onnxruntime-node usage is unnecessary |
| External vector databases for search | In-process brute-force for small datasets | Always (for <10k items) | No external dependency needed at Twining's scale |

**Deprecated/outdated:**
- `@xenova/transformers`: Renamed to `@huggingface/transformers` in v3. The old package still works but is no longer maintained.

## Open Questions

1. **Model cache location and .gitignore**
   - What we know: Models cached in `env.cacheDir`. Spec says `.twining/.gitignore` excludes `embeddings/*.index`.
   - What's unclear: Should model files (`.twining/models/`) also be gitignored? Likely yes (they're ~23MB binaries).
   - Recommendation: Add `models/` to `.twining/.gitignore`. Models re-download automatically on first use.

2. **Embedding index rebuild on ONNX recovery**
   - What we know: If ONNX fails, we fall back to keyword search.
   - What's unclear: If ONNX becomes available later (e.g., next server restart), should we rebuild the index for entries created during fallback?
   - Recommendation: Yes, on successful embedder init, check for entries without embeddings and backfill them.

3. **Pipeline instance thread safety**
   - What we know: Transformers.js docs note "doesn't support simultaneous loading of sessions."
   - What's unclear: Whether concurrent `embed()` calls on the same pipeline instance are safe.
   - Recommendation: Serialize embedding operations through a queue or use a mutex. The volume is low enough (one embedding per write) that this won't be a bottleneck.

## Sources

### Primary (HIGH confidence)
- [HuggingFace Transformers.js Node.js Tutorial](https://huggingface.co/docs/transformers.js/tutorials/node) — Lazy loading singleton pattern, pipeline API, caching
- [HuggingFace Transformers.js Installation](https://huggingface.co/docs/transformers.js/en/installation) — Package install, version info
- [HuggingFace ONNX Backend Docs](https://huggingface.co/docs/transformers.js/api/backends/onnx) — How transformers.js selects onnxruntime-node vs onnxruntime-web
- [Xenova/all-MiniLM-L6-v2 Model Card](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — Model details, 384 dimensions, pipeline usage
- [TWINING-DESIGN-SPEC.md](./../../TWINING-DESIGN-SPEC.md) — Authoritative spec for data models, tool signatures, embedding index structure

### Secondary (MEDIUM confidence)
- [How to Create Vector Embeddings in Node.js](https://philna.sh/blog/2024/09/25/how-to-create-vector-embeddings-in-node-js/) — Practical Node.js embedding examples
- [TypeScript Cosine Similarity Implementation](https://alexop.dev/posts/how-to-implement-a-cosine-similarity-function-in-typescript-for-vector-comparison/) — Performance patterns for vector operations

### Tertiary (LOW confidence)
- None — all findings verified against primary or secondary sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `@huggingface/transformers` is the official, well-documented package for this exact use case
- Architecture: HIGH — Patterns come directly from official tutorials and the project's design spec
- Pitfalls: HIGH — Platform compatibility and model limits are well-documented; concurrency issues verified via docs

**Research date:** 2026-02-16
**Valid until:** 2026-03-16 (stable domain, 30-day validity)
