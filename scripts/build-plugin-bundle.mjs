#!/usr/bin/env node
/**
 * Builds the dependency-free single-file server bundle with esbuild.
 *
 * Outputs (byte-identical to each other):
 *   - dist/server.bundle.mjs            (published in the npm tarball)
 *   - plugin/server/twining-server.mjs  (committed, ships with the plugin)
 *
 * Each output also gets a sibling public/ copy of the dashboard static
 * assets, because http-server.ts resolves publicDir relative to the
 * module location (path.join(dirname(fileURLToPath(import.meta.url)), "public")).
 *
 * Externalized (loaded dynamically at runtime with graceful fallback):
 *   - @huggingface/transformers  (embedder.ts — try/catch, keyword fallback)
 *   - posthog-node               (telemetry-client.ts — Function() import, no-op fallback)
 *   - open                       (http-server.ts — .catch(), auto-open skipped;
 *                                 must stay external: it locates a vendored
 *                                 xdg-open via __dirname and breaks if bundled)
 *
 * Keyless by construction: the _generated-posthog-key module is replaced
 * with the empty-string placeholder via an esbuild plugin, so the bundle
 * never contains an injected PostHog key regardless of working-tree or CI
 * state. This also keeps the output deterministic (same inputs + same
 * esbuild version => byte-identical bundle) so CI can diff for freshness.
 *
 * --dist-only (publish workflow): writes only dist/server.bundle.mjs and
 * skips the placeholder plugin, so the tarball bundle carries whatever
 * src/analytics/_generated-posthog-key.ts contains at build time — the
 * same key handling as tsc gives dist/index.js. The committed
 * plugin/server/ bundle is never touched (and never keyed) in this mode.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const distOnly = process.argv.includes("--dist-only");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

/**
 * Replace src/analytics/_generated-posthog-key.ts with the placeholder
 * (empty key), whatever the working tree contains. See
 * scripts/inject-posthog-key.mjs for the runtime-injection counterpart.
 */
const posthogKeyPlaceholder = {
  name: "posthog-key-placeholder",
  setup(build) {
    build.onResolve({ filter: /_generated-posthog-key(\.js)?$/ }, () => ({
      path: "_generated-posthog-key",
      namespace: "posthog-key-placeholder",
    }));
    build.onLoad({ filter: /.*/, namespace: "posthog-key-placeholder" }, () => ({
      contents: 'export const POSTHOG_API_KEY = "";\n',
      loader: "js",
    }));
  },
};

// js-yaml and proper-lockfile (plus its deps graceful-fs/retry/signal-exit)
// are CJS; esbuild converts statically-resolvable requires, but its
// __require fallback for anything dynamic needs a real `require` in scope.
// Assign via globalThis instead of `const require = ...` so the banner can
// never collide with bundled top-level bindings (e.g. sqlite/db.ts).
const banner = [
  'import { createRequire as __twiningCreateRequire } from "node:module";',
  'if (typeof globalThis.require === "undefined") {',
  "  globalThis.require = __twiningCreateRequire(import.meta.url);",
  "}",
].join("\n");

const result = await build({
  entryPoints: [join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@huggingface/transformers", "posthog-node", "open"],
  banner: { js: banner },
  define: { __TWINING_VERSION__: JSON.stringify(pkg.version) },
  plugins: distOnly ? [] : [posthogKeyPlaceholder],
  outfile: "server.bundle.mjs", // name only — written manually below
  write: false,
  sourcemap: false,
  minify: false,
  logLevel: "warning",
});

const [output] = result.outputFiles;

const targets = [
  { file: join(root, "dist", "server.bundle.mjs"), publicDir: join(root, "dist", "public") },
  ...(distOnly
    ? []
    : [{ file: join(root, "plugin", "server", "twining-server.mjs"), publicDir: join(root, "plugin", "server", "public") }]),
];

const publicSrc = join(root, "src", "dashboard", "public");

for (const { file, publicDir } of targets) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, output.contents);
  rmSync(publicDir, { recursive: true, force: true });
  cpSync(publicSrc, publicDir, { recursive: true });
  console.log(`[build-plugin-bundle] ${file} (${output.contents.byteLength} bytes) + public/`);
}
