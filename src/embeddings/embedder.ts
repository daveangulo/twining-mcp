/**
 * Lazy-loaded singleton embedding pipeline using @huggingface/transformers.
 * Uses all-MiniLM-L6-v2 (384 dimensions) via ONNX runtime.
 * Falls back gracefully to keyword-only mode if ONNX fails.
 */
import path from "node:path";

// Type for the pipeline function result
type FeatureExtractionPipeline = (
  text: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export class Embedder {
  private static instances = new Map<string, Embedder>();

  private readonly twiningDir: string;
  private pipeline: FeatureExtractionPipeline | null = null;
  private fallbackMode = false;
  private initPromise: Promise<void> | null = null;

  constructor(twiningDir: string) {
    this.twiningDir = twiningDir;
  }

  /** Get or create a singleton instance for a given twiningDir. */
  static getInstance(twiningDir: string): Embedder {
    const existing = Embedder.instances.get(twiningDir);
    if (existing) return existing;
    const instance = new Embedder(twiningDir);
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
    try {
      // Dynamic import to avoid loading ONNX at module evaluation time
      const { pipeline, env } = await import("@huggingface/transformers");

      // Configure model cache within .twining/
      env.cacheDir = path.join(this.twiningDir, "models");

      // Create the feature extraction pipeline
      this.pipeline = (await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
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
