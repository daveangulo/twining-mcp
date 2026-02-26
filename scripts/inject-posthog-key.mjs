#!/usr/bin/env node
/**
 * Generates src/analytics/_generated-posthog-key.ts with the PostHog API key
 * read from the POSTHOG_API_KEY environment variable.
 *
 * Run automatically via the "prebuild" npm script.
 * The generated file is .gitignored — it only exists in build artifacts
 * that ship to npm.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../src/analytics/_generated-posthog-key.ts");

const key = process.env.POSTHOG_API_KEY || "";

const content = `// AUTO-GENERATED — do not edit. See scripts/inject-posthog-key.mjs
export const POSTHOG_API_KEY = ${JSON.stringify(key)};
`;

writeFileSync(outPath, content, "utf-8");

if (key) {
  console.log("[inject-posthog-key] Baked PostHog API key into build.");
} else {
  console.log("[inject-posthog-key] No POSTHOG_API_KEY set — telemetry key will be empty in this build.");
}
