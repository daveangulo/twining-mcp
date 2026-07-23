import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BUNDLE = path.resolve(
  __dirname,
  "..",
  "plugin",
  "server",
  "twining-server.mjs",
);
const PKG = path.resolve(__dirname, "..", "package.json");

// Same discrimination strategy as server-startup.test.ts: the reliable
// cross-platform signal that startup ran is stderr content ([twining]
// messages), not exit codes or signals. spawnSync with input:"" sends EOF
// on stdin so the stdio transport shuts down instead of hanging.

function runBundle(args: string[], cwd: string) {
  return spawnSync("node", [BUNDLE, ...args], {
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "TWINING_DISABLED"),
      ),
      // Port 0 → OS-assigned port (no collision with a real dashboard);
      // NO_OPEN → never launch a browser from tests.
      TWINING_DASHBOARD_PORT: "0",
      TWINING_DASHBOARD_NO_OPEN: "1",
    },
    input: "", // EOF on stdin so the server doesn't hang waiting for JSON-RPC
    encoding: "utf8",
    timeout: 15000,
  });
}

describe("plugin server bundle", () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!fs.existsSync(BUNDLE)) {
      throw new Error(
        `plugin/server/twining-server.mjs missing — run \`npm run build:plugin\` before this test`,
      );
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-bundle-"));
    fs.mkdirSync(path.join(tmpDir, ".twining"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("boots from a foreign cwd and prints the [twining] startup banner", () => {
    const result = runBundle([], tmpDir);
    expect(result.status).toBe(0);
    // Startup ran to completion — stderr carries [twining] messages from the
    // dashboard and/or config loader. Empty stderr would mean startup died
    // before doing anything, which is the failure case for this test.
    expect(result.stderr).toContain("[twining]");
  });

  it("reports the package.json version despite relocation (define-injected)", () => {
    const { version } = JSON.parse(fs.readFileSync(PKG, "utf8")) as {
      version: string;
    };
    const result = runBundle(["--version"], tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`twining-mcp ${version}`);
  });

  describe("bundle contents", () => {
    let src: string;

    beforeAll(() => {
      src = fs.readFileSync(BUNDLE, "utf8");
    });

    it("contains the PostHog placeholder key, never a real key", () => {
      // The keyless-build guarantee: the placeholder (empty string) is baked
      // in by the posthog-key-placeholder esbuild plugin regardless of any
      // injected _generated-posthog-key.ts in the working tree.
      expect(src).toMatch(/POSTHOG_API_KEY = ""/);
      // Real PostHog project API keys look like phc_<base62>.
      expect(src).not.toMatch(/phc_[A-Za-z0-9]{10,}/);
    });

    it("does not bundle @huggingface/transformers (externalized)", () => {
      expect(src).not.toContain("node_modules/@huggingface");
    });
  });
});
