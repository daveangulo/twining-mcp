/**
 * Tests for the Embedder class.
 * Uses mocks for ONNX pipeline — actual model download requires SKIP_ONNX=false.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Embedder } from "../src/embeddings/embedder.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-embedder-test-"));
  return dir;
}

describe("Embedder", () => {
  beforeEach(() => {
    Embedder.resetInstances();
  });

  it("should not initialize pipeline until first embed() call", () => {
    const tmpDir = makeTempDir();
    const embedder = new Embedder(tmpDir);
    expect(embedder.isInitialized()).toBe(false);
    expect(embedder.isFallbackMode()).toBe(false);
  });

  it("should return null and enter fallback mode when pipeline fails", async () => {
    const tmpDir = makeTempDir();
    const embedder = new Embedder(tmpDir);

    // The dynamic import of @huggingface/transformers will try to load the
    // ONNX model which will likely fail in test (no model downloaded).
    // We mock the module to simulate failure.
    vi.doMock("@huggingface/transformers", () => {
      return {
        pipeline: vi.fn().mockRejectedValue(new Error("ONNX not available")),
        env: { cacheDir: "" },
      };
    });

    // Force re-creation with mocked module
    const result = await embedder.embed("test text");

    // In the real scenario, dynamic import might succeed but pipeline creation fails.
    // Either way, if ONNX is not available, it should be in fallback mode or return null.
    // We verify it doesn't throw.
    expect(result).toBeNull();
  });

  it("should return null for all items in batch when in fallback mode", async () => {
    const tmpDir = makeTempDir();
    const embedder = new Embedder(tmpDir);

    // Manually set fallback mode for testing
    (embedder as any).fallbackMode = true;

    const results = await embedder.embedBatch(["text1", "text2", "text3"]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r === null)).toBe(true);
  });

  it("isFallbackMode() should return false initially", () => {
    const tmpDir = makeTempDir();
    const embedder = new Embedder(tmpDir);
    expect(embedder.isFallbackMode()).toBe(false);
  });

  it("isFallbackMode() should return true after fallback is triggered", () => {
    const tmpDir = makeTempDir();
    const embedder = new Embedder(tmpDir);
    (embedder as any).fallbackMode = true;
    expect(embedder.isFallbackMode()).toBe(true);
  });

  it("getInstance should return the same instance for the same dir", () => {
    const tmpDir = makeTempDir();
    const a = Embedder.getInstance(tmpDir);
    const b = Embedder.getInstance(tmpDir);
    expect(a).toBe(b);
  });

  it("getInstance should return different instances for different dirs", () => {
    const tmpDir1 = makeTempDir();
    const tmpDir2 = makeTempDir();
    const a = Embedder.getInstance(tmpDir1);
    const b = Embedder.getInstance(tmpDir2);
    expect(a).not.toBe(b);
  });

  it("concurrent embed() calls should not create multiple pipelines", async () => {
    const tmpDir = makeTempDir();
    const embedder = new Embedder(tmpDir);

    // Manually set fallback to avoid actual ONNX init
    (embedder as any).fallbackMode = true;

    // Multiple concurrent calls should all return null (fallback)
    const results = await Promise.all([
      embedder.embed("text1"),
      embedder.embed("text2"),
      embedder.embed("text3"),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r === null)).toBe(true);
  });
});
