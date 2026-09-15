/**
 * Lazy-loaded singleton embedding pipeline using @huggingface/transformers.
 * Uses all-MiniLM-L6-v2 (384 dimensions) via ONNX runtime.
 * Falls back gracefully to keyword-only mode if ONNX fails.
 */
import fs from "node:fs";
import path from "node:path";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Type for the pipeline function result
type FeatureExtractionPipeline = (
  text: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export interface EmbedderOptions {
  /** Never attempt a model download; fall back to keyword search instead. */
  offline?: boolean;
}

/** Where transformers.js caches the model (env.cacheDir) for a given store. */
export function modelCacheDir(twiningDir: string): string {
  return path.join(twiningDir, "models");
}

/** Whether the ONNX model is already on disk for this store. */
export function hasCachedModel(twiningDir: string): boolean {
  try {
    const dir = path.join(modelCacheDir(twiningDir), MODEL_ID);
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export class Embedder {
  private static instances = new Map<string, Embedder>();

  private readonly twiningDir: string;
  private pipeline: FeatureExtractionPipeline | null = null;
  private fallbackMode = false;
  private initPromise: Promise<void> | null = null;
  /** Offline mode: never let transformers.js reach the network (2.17.0).
   *  Set by the CLI, whose sandboxes (Codex) have no network at all — a
   *  download attempt there is a multi-second hang ending in the same
   *  keyword fallback we can choose up front and say so. */
  private offline: boolean;

  constructor(twiningDir: string, options: EmbedderOptions = {}) {
    this.twiningDir = twiningDir;
    this.offline = options.offline ?? false;
  }

  /**
   * Get or create a singleton instance for a given twiningDir.
   *
   * In practice the CLI always constructs the first instance in its own fresh
   * process, so `options` is never dropped on a real path. Even so, a cached
   * instance is UPGRADED to offline when offline is asked for and never
   * downgraded: offline is the strictly more conservative mode, so silently
   * honouring the earlier, more permissive flag is the one direction that
   * could put a request on the network that a caller had ruled out.
   */
  static getInstance(twiningDir: string, options: EmbedderOptions = {}): Embedder {
    const existing = Embedder.instances.get(twiningDir);
    if (existing) {
      if (options.offline) existing.offline = true;
      return existing;
    }
    const instance = new Embedder(twiningDir, options);
    Embedder.instances.set(twiningDir, instance);
    return instance;
  }

  /** Reset singleton instances (for testing). */
  static resetInstances(): void {
    Embedder.instances.clear();
  }

  /** Generate a 384-dimensional embedding for the given text. Returns null if in fallback mode. */
  async embed(text: string): Promise<number[] | null> {
    if (this.fallbackMode) return null;

    if (!this.pipeline) {
      await this.initialize();
    }

    if (this.fallbackMode || !this.pipeline) return null;

    try {
      const output = await this.pipeline(text, {
        pooling: "mean",
        normalize: true,
      });
      return Array.from(output.data);
    } catch (error) {
      // Transient embedding errors don't trigger fallback mode
      console.error("[twining] Embedding error (non-fatal):", error);
      return null;
    }
  }

  /** Generate embeddings for multiple texts. Returns null for any that fail. */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (this.fallbackMode) return texts.map(() => null);

    if (!this.pipeline) {
      await this.initialize();
    }

    if (this.fallbackMode || !this.pipeline) return texts.map(() => null);

    const results: (number[] | null)[] = [];
    for (const text of texts) {
      try {
        const output = await this.pipeline(text, {
          pooling: "mean",
          normalize: true,
        });
        results.push(Array.from(output.data));
      } catch (error) {
        console.error("[twining] Batch embedding error (non-fatal):", error);
        results.push(null);
      }
    }
    return results;
  }

  /** Whether the embedder has fallen back to keyword-only mode. */
  isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  /** Whether the pipeline has been initialized (for testing). */
  isInitialized(): boolean {
    return this.pipeline !== null || this.fallbackMode;
  }

  /** Initialize the ONNX pipeline. Called lazily on first embed(). */
  private async initialize(): Promise<void> {
    // Prevent concurrent initialization
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Skip expensive ONNX initialization in test environment
    if (process.env.VITEST) {
      this.fallbackMode = true;
      return;
    }

    // Offline with no cached model: choose the fallback rather than let
    // transformers.js try (and slowly fail) to fetch it. Said out loud on
    // stderr so a keyword-only session is never silent about why.
    if (this.offline && !hasCachedModel(this.twiningDir)) {
      console.error(
        `[twining] No local embedding model at ${path.join(modelCacheDir(this.twiningDir), MODEL_ID)} — using keyword search (offline mode: no download attempted).`,
      );
      this.fallbackMode = true;
      return;
    }

    try {
      // Dynamic import to avoid loading ONNX at module evaluation time
      const { pipeline, env } = await import("@huggingface/transformers");

      // Configure model cache within .twining/
      env.cacheDir = modelCacheDir(this.twiningDir);
      // Belt and braces: even with a cached model present, offline mode must
      // never let a missing shard turn into a fetch.
      if (this.offline) env.allowRemoteModels = false;

      // Create the feature extraction pipeline
      this.pipeline = (await pipeline(
        "feature-extraction",
        MODEL_ID,
      )) as unknown as FeatureExtractionPipeline;
    } catch (error) {
      console.error(
        "[twining] ONNX embedding initialization failed. Falling back to keyword search:",
        error,
      );
      this.fallbackMode = true;
    }
  }
}
