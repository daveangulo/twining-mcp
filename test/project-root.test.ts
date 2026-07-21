/**
 * Project-root resolution (#46): --project arg > TWINING_PROJECT env > cwd.
 * Lets the plugin-contributed server target a shared store via one
 * version-agnostic env line instead of a per-repo .mcp.json override plus a
 * brittle exact-command deniedMcpServers block.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveProjectRoot } from "../src/utils/project-root.js";

const CWD = "/repos/wfos-registry";

describe("resolveProjectRoot", () => {
  it("defaults to cwd with no arg and no env", () => {
    expect(resolveProjectRoot([], {}, CWD)).toBe(CWD);
  });

  it("uses TWINING_PROJECT when no --project arg is given", () => {
    expect(
      resolveProjectRoot([], { TWINING_PROJECT: "/shared/wfos-chassis" }, CWD),
    ).toBe("/shared/wfos-chassis");
  });

  it("resolves a relative TWINING_PROJECT against cwd", () => {
    expect(
      resolveProjectRoot([], { TWINING_PROJECT: "../wfos-chassis" }, CWD),
    ).toBe(path.resolve(CWD, "../wfos-chassis"));
  });

  it("--project overrides TWINING_PROJECT", () => {
    expect(
      resolveProjectRoot(
        ["--project", "/explicit/path"],
        { TWINING_PROJECT: "/shared/wfos-chassis" },
        CWD,
      ),
    ).toBe("/explicit/path");
  });

  it("empty TWINING_PROJECT is ignored (falls back to cwd)", () => {
    expect(resolveProjectRoot([], { TWINING_PROJECT: "" }, CWD)).toBe(CWD);
  });

  it("--project without a following value falls back to env then cwd", () => {
    expect(
      resolveProjectRoot(
        ["--project"],
        { TWINING_PROJECT: "/shared/wfos-chassis" },
        CWD,
      ),
    ).toBe("/shared/wfos-chassis");
  });

  it("relative --project is preserved as-is (existing behavior, no regression)", () => {
    // The 1.x server passed relative --project values straight through;
    // keep that contract for arg users.
    expect(resolveProjectRoot(["--project", "."], {}, CWD)).toBe(".");
  });
});
