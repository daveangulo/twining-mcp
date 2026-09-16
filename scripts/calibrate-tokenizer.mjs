#!/usr/bin/env node
/**
 * Generate a calibration table for `src/retrieval/tokenizer.ts` (DP4).
 *
 * The shipped default (`PROVEN_TABLE`) charges one token per UTF-8 byte. That
 * is a mathematical upper bound for any byte-level BPE whose vocabulary holds
 * all 256 single bytes — it cannot undercount, needs no model, and is therefore
 * the right DEFAULT. It is also about 4x loose on English prose.
 *
 * This script tightens it with MEASUREMENT rather than with a guess. For each
 * character class it finds the maximum observed tokens-per-byte ratio over a
 * corpus, multiplies by a safety factor, and clamps to the proven bound (a
 * measurement may only ever make the estimate tighter).
 *
 *   node scripts/calibrate-tokenizer.mjs \
 *     --corpus test/fixtures/tokenizer-corpus \
 *     --out src/retrieval/calibration.json \
 *     --safety 1.15
 *
 * Requires ANTHROPIC_API_KEY. It is NEVER run from the test suite: the budget
 * path must work offline, and a test that could reach the network is a test
 * that can fail for reasons unrelated to what it asserts.
 *
 * ## Why a max and not a mean
 *
 * A mean ratio undercounts half the corpus by construction, and an undercount
 * is not a bound. The max over documents DOMINATED by a class is the tightest
 * ratio that still holds for every document in the corpus. The safety factor
 * then covers documents the corpus does not contain.
 *
 * ## Honest limits
 *
 * A calibrated table is an empirical bound over the corpus it was measured on,
 * not a proof. Text unlike the corpus can exceed it. That is why:
 *   - the table records its corpus (name, document count, bytes, sha256);
 *   - `provenance` is `measured`, never `proven-upper-bound`;
 *   - every estimate still reports `conservative_fallback: true`;
 *   - budget-critical callers can ask for the exact count instead.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const CORPUS = args.corpus ?? "test/fixtures/tokenizer-corpus";
const OUT = args.out ?? "src/retrieval/calibration.json";
const SAFETY = Number(args.safety ?? 1.15);
const MODEL = args.model ?? "claude-sonnet-4-5";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Refusing to emit a table with no measurement behind it.");
  console.error("The shipped PROVEN_TABLE remains correct (and conservative) without this step.");
  process.exit(2);
}

/** Must match `classifyBytes` in src/retrieval/tokenizer.ts exactly. */
function classifyBytes(text) {
  const out = { ascii_alnum: 0, ascii_space: 0, ascii_punct: 0, latin1_supp: 0, multibyte: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const bytes = Buffer.byteLength(ch, "utf8");
    if (cp < 0x80) {
      if ((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) out.ascii_alnum += bytes;
      else if (cp === 32 || cp === 9 || cp === 10 || cp === 13) out.ascii_space += bytes;
      else out.ascii_punct += bytes;
    } else if (cp < 0x100) out.latin1_supp += bytes;
    else out.multibyte += bytes;
  }
  return out;
}

const files = fs
  .readdirSync(CORPUS, { withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => path.join(CORPUS, d.name));

if (files.length === 0) {
  console.error(`No corpus documents under ${CORPUS}.`);
  process.exit(2);
}

const { default: Anthropic } = await import("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const observedMax = {};
const corpusHash = createHash("sha256");
let totalBytes = 0;

const skipped = [];

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");

  /**
   * A whitespace-only (or empty) document cannot be counted: the API refuses
   * the request with `400 text content blocks must contain non-whitespace
   * text`, which aborts the whole run — one blank fixture file is enough to
   * make calibration impossible (found 2026-09-15; it is why the first
   * calibration pass failed and the proven 1 token/byte bound shipped instead).
   *
   * Skipping is the right answer rather than padding: such a document carries
   * no bytes of any class, so it cannot tighten a ratio, and padding it would
   * measure text the corpus does not actually contain. Skipped documents are
   * excluded from the corpus hash and byte total too, so the recorded corpus
   * describes what was measured.
   */
  if (text.trim() === "") {
    console.log(`  skip (blank): ${path.basename(file)}`);
    skipped.push(path.basename(file));
    continue;
  }

  corpusHash.update(text);
  totalBytes += Buffer.byteLength(text, "utf8");

  const res = await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: text }] });
  const tokens = res.input_tokens;
  const classes = classifyBytes(text);
  const bytes = Object.values(classes).reduce((a, b) => a + b, 0);

  // Attribute the document to the class holding the majority of its bytes.
  // A document that is not clearly dominated by one class cannot tighten any
  // single ratio without assuming how the tokens split, so it is skipped.
  const [dominant, dominantBytes] = Object.entries(classes).sort((a, b) => b[1] - a[1])[0];
  if (dominantBytes / bytes < 0.8) {
    console.log(`  skip (mixed): ${path.basename(file)}`);
    continue;
  }
  const ratio = tokens / bytes;
  observedMax[dominant] = Math.max(observedMax[dominant] ?? 0, ratio);
  console.log(`  ${path.basename(file)}: ${tokens} tokens / ${bytes} bytes = ${ratio.toFixed(4)} (${dominant})`);
}

const PROVEN = { ascii_alnum: 1, ascii_space: 1, ascii_punct: 1, latin1_supp: 1, multibyte: 1 };
const ratios = {};
for (const cls of Object.keys(PROVEN)) {
  const measured = observedMax[cls];
  ratios[cls] = measured === undefined ? PROVEN[cls] : Math.min(PROVEN[cls], measured * SAFETY);
  if (measured === undefined) console.log(`  ${cls}: no dominated document — keeping the proven ratio 1`);
}

const table = {
  id: `measured-${MODEL}/${new Date().toISOString().slice(0, 10)}`,
  provenance: "measured",
  reference: `anthropic-count-tokens/${MODEL}`,
  corpus: {
    skipped_blank: skipped,
    name: path.basename(CORPUS),
    documents: files.length - skipped.length,
    bytes: totalBytes,
    sha256: `sha256:${corpusHash.digest("hex")}`,
  },
  safety_factor: SAFETY,
  ratios,
  envelope_overhead_tokens: 8,
};

fs.writeFileSync(OUT, JSON.stringify(table, null, 2) + "\n", "utf8");
console.log(`\nWrote ${OUT}`);
console.log(JSON.stringify(table, null, 2));
