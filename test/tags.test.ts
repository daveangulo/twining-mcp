import { describe, it, expect } from "vitest";
import { normalizeTags } from "../src/utils/tags.js";

describe("normalizeTags", () => {
  it("lowercases tags", () => {
    expect(normalizeTags(["Testing", "CODE-REVIEW"])).toEqual([
      "testing",
      "code-review",
    ]);
  });

  it("trims whitespace", () => {
    expect(normalizeTags(["  spaces  ", "tabs"])).toEqual(["spaces", "tabs"]);
  });

  it("deduplicates case-insensitive duplicates", () => {
    expect(normalizeTags(["test", "Test", "TEST"])).toEqual(["test"]);
  });

  it("filters empty strings", () => {
    expect(normalizeTags(["", "  ", "valid"])).toEqual(["valid"]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeTags([])).toEqual([]);
  });

  it("handles mixed case with duplicates and whitespace", () => {
    expect(normalizeTags(["Testing", "testing", " Testing "])).toEqual([
      "testing",
    ]);
  });
});
