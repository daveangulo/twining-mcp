/**
 * Bundle the `twining` CLI once per suite, from src/, with esbuild.
 *
 * Same recipe test/cli/twining.test.ts uses, extracted so the hook tests and
 * the baseline-gap tests can share it. The suites must not depend on a prior
 * `npm run build`: the main checkout deliberately never builds dist/ (its dist
 * serves every session on this machine through the npm link), so a test that
 * needed one would either be unrunnable or would quietly test a stale binary.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PKG_VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

/** Where the bundled CLI lands. Under node_modules so bare imports resolve. */
export const CLI_BUNDLE = path.join(REPO_ROOT, "node_modules", ".cache", "twining-cli-test", "twining.mjs");

let built: Promise<string> | null = null;

export async function bundleCli(): Promise<string> {
  if (!built) {
    built = (async () => {
      const { build } = await import("esbuild");
      fs.mkdirSync(path.dirname(CLI_BUNDLE), { recursive: true });
      await build({
        entryPoints: [path.join(REPO_ROOT, "src", "cli", "twining.ts")],
        outfile: CLI_BUNDLE,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        packages: "external",
        sourcemap: "inline",
        logLevel: "silent",
        // Relocation-safe version injection, matching scripts/build-plugin-bundle.mjs:
        // src/version.ts's package.json fallback is only valid at dist/ depth.
        define: { __TWINING_VERSION__: JSON.stringify(PKG_VERSION) },
      });
      return CLI_BUNDLE;
    })();
  }
  return built;
}
