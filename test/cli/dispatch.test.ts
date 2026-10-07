import { describe, expect, it } from "vitest";
import {
  classifyArgv,
  CLI_USAGE,
  KNOWN_SUBCOMMANDS,
} from "../../src/cli/dispatch.js";

const argv = (...rest: string[]) => ["node", "dist/index.js", ...rest];

describe("classifyArgv (2.16.1)", () => {
  it("no argument and flag-first argv start the server", () => {
    expect(classifyArgv(argv())).toEqual({ kind: "server" });
    expect(classifyArgv(argv("--project", "."))).toEqual({ kind: "server" });
    expect(classifyArgv(argv("-v"))).toEqual({ kind: "server" });
  });
  it("known subcommands dispatch with their remaining args", () => {
    expect(classifyArgv(argv("migrate", "--dry-run"))).toEqual({
      kind: "subcommand",
      name: "migrate",
      args: ["--dry-run"],
    });
    expect(classifyArgv(argv("validate-records"))).toEqual({
      kind: "subcommand",
      name: "validate-records",
      args: [],
    });
    // The v3 migration verbs (lane 02c): rollback and events must be reachable
    // while the store is rolled back, when no other read surface works.
    expect(classifyArgv(argv("rollback", "--to", "2"))).toEqual({
      kind: "subcommand",
      name: "rollback",
      args: ["--to", "2"],
    });
    expect(classifyArgv(argv("events", "ls"))).toEqual({
      kind: "subcommand",
      name: "events",
      args: ["ls"],
    });
    expect(KNOWN_SUBCOMMANDS).toEqual(["migrate", "rollback", "migrate-status", "events", "validate-records"]);
  });
  it("an unknown non-flag word is refused, never treated as the server", () => {
    expect(classifyArgv(argv("drain"))).toEqual({ kind: "unknown", word: "drain" });
    expect(classifyArgv(argv("sync-status", "--json"))).toEqual({
      kind: "unknown",
      word: "sync-status",
    });
    expect(CLI_USAGE).toContain("validate-records");
  });
});
