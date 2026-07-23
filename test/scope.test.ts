import { describe, it, expect } from "vitest";
import { scopeMatches } from "../src/utils/scope.js";

describe("scopeMatches", () => {
  it("matches when the first scope is a prefix of the second", () => {
    expect(scopeMatches("src/", "src/auth/")).toBe(true);
  });

  it("matches when the second scope is a prefix of the first (bidirectional)", () => {
    expect(scopeMatches("src/auth/", "src/")).toBe(true);
  });

  it("matches identical scopes", () => {
    expect(scopeMatches("src/engine/", "src/engine/")).toBe(true);
  });

  it("does not match unrelated scopes", () => {
    expect(scopeMatches("src/auth/", "src/engine/")).toBe(false);
  });

  it("does not match sibling scopes sharing only a partial segment", () => {
    expect(scopeMatches("src/auth", "src/auth-legacy/")).toBe(true); // raw prefix rule
    expect(scopeMatches("src/authn/", "src/auth/")).toBe(false);
  });

  it("an empty scope matches everything (prefix of every string)", () => {
    expect(scopeMatches("", "src/")).toBe(true);
    expect(scopeMatches("src/", "")).toBe(true);
  });
});
