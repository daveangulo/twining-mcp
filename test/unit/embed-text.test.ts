/**
 * Canonical embed-text derivation — the single definition shared by the
 * live embed path, keyword-fallback search, and the sync reconciler.
 */
import { describe, expect, it } from "vitest";
import {
  blackboardEmbedText,
  decisionEmbedText,
  embedContentHash,
} from "../../src/embeddings/embed-text.js";

describe("embed-text", () => {
  it("derives blackboard text as summary + detail (legacy format, byte-exact)", () => {
    expect(blackboardEmbedText({ summary: "s", detail: "d" })).toBe("s d");
    expect(blackboardEmbedText({ summary: "s", detail: "" })).toBe("s ");
  });

  it("derives decision text as summary + rationale + context (legacy format)", () => {
    expect(
      decisionEmbedText({ summary: "s", rationale: "r", context: "c" }),
    ).toBe("s r c");
  });

  it("hashes are stable, hex sha256, and change with the text", () => {
    const h = embedContentHash("hello");
    expect(h).toBe(embedContentHash("hello"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(embedContentHash("hello!")).not.toBe(h);
  });
});
