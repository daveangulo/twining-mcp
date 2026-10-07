/**
 * Single source for the running server/CLI version.
 *
 * __TWINING_VERSION__ is baked in by the bundle build (relocation-safe); the
 * tsc build falls back to a package.json lookup relative to dist/ — which is
 * why this module lives at src/ depth and must not be moved into a
 * subdirectory without fixing the relative path.
 */
import { createRequire } from "node:module";

export const PKG_VERSION: string =
  typeof __TWINING_VERSION__ !== "undefined"
    ? __TWINING_VERSION__
    : (createRequire(import.meta.url)("../package.json") as { version: string })
        .version;
