/**
 * Build-time constants injected by esbuild `define` in
 * scripts/build-plugin-bundle.mjs.
 *
 * Undefined in the plain tsc build (dist/index.js) — consumers must guard
 * with `typeof __TWINING_VERSION__ !== "undefined"` and fall back to the
 * package.json lookup, which is only valid when the compiled file sits at
 * its original location relative to package.json.
 */
declare const __TWINING_VERSION__: string | undefined;
