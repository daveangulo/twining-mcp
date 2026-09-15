/**
 * DP4 — the declared token estimator (oracle C26 A01–A04).
 *
 * ## What a budget has to mean
 *
 * `max_tokens: 4000` has to be a bound the emitted payload cannot cross. The
 * 2.x estimator (`src/utils/tokens.ts`, `ceil(chars/4)`) is a *central*
 * estimate: it is wrong in both directions, and it undercounts on exactly the
 * content that matters — JSON punctuation, escaped strings, code, CJK, emoji.
 * A bound that undercounts is not a bound.
 *
 * So this estimator is **conservative by construction**: for every input it
 * returns a value greater than or equal to the true token count of any
 * byte-level BPE tokenizer whose vocabulary contains all 256 single bytes.
 * Every production tokenizer in this class (cl100k, o200k, Claude's) qualifies.
 *
 * ## The bound, and why it is what it is
 *
 * In such a tokenizer every token decodes to at least one byte, so
 *
 *     tokens(s) <= utf8_byte_length(s)
 *
 * and that inequality is tight (a string of bytes with no merges costs one
 * token per byte). This is a *proof*, not a measurement — it cannot undercount
 * and it needs no vocabulary, no network and no model file.
 *
 * It is also loose: real English prose runs about 4 bytes/token, so the proven
 * bound charges ~4x. That cost is deliberate and is the conservative default
 * my brief asks for. The calibration machinery below exists so the bound can
 * be *tightened with evidence* rather than with a guess:
 *
 *  - `TABLES.proven` — ratios that are mathematically 1 token per byte. Shipped
 *    as the default. Provenance `proven-upper-bound`. Never undercounts.
 *  - `TABLES.calibrated_*` — per-class max ratios MEASURED against a named
 *    reference tokenizer over a named corpus, times a safety factor. Generated
 *    by `scripts/calibrate-tokenizer.mjs`, which needs a real tokenizer and is
 *    therefore not run in tests.
 *
 * No calibrated table is shipped today because this environment has no
 * reference tokenizer and no `ANTHROPIC_API_KEY`; inventing ratios would be
 * exactly the fabrication the bound exists to prevent. The harness, the corpus
 * and the table format are in place so one run with a key produces a real one.
 *
 * ## Exact mode
 *
 * `countExact` calls the Anthropic count-tokens API, and ONLY when
 * `ANTHROPIC_API_KEY` is set and `allow_network` is passed. It is never
 * reached from a test: `estimate()` is pure and synchronous.
 */

export const TOKENIZER_NAME = "twining-conservative-utf8";
export const TOKENIZER_VERSION = "1.0.0";
export const TOKENIZER_ID = `${TOKENIZER_NAME}/${TOKENIZER_VERSION}`;

/**
 * Character classes the calibration table is keyed on. Splitting the text this
 * way is what lets a calibrated table be tighter than a single global ratio:
 * ASCII prose compresses far better than punctuation or CJK, and a single
 * average would have to be pinned to the worst class.
 */
export type CharClass = "ascii_alnum" | "ascii_space" | "ascii_punct" | "latin1_supp" | "multibyte";

export interface CalibrationTable {
  /** Table identity, recorded in every receipt. */
  id: string;
  /** How the ratios were obtained. A reader must be able to tell. */
  provenance: "proven-upper-bound" | "measured";
  /** The reference tokenizer the ratios were measured against, when measured. */
  reference?: string;
  /** The corpus the ratios were measured over, when measured. */
  corpus?: { name: string; documents: number; bytes: number; sha256: string };
  /** Multiplier applied to every measured max ratio. 1 for a proven table. */
  safety_factor: number;
  /** Upper bound on tokens per UTF-8 BYTE of text in this class. */
  ratios: Record<CharClass, number>;
  /**
   * Tokens charged for the payload as a whole, independent of content: BOS/EOS
   * and any wrapper the transport adds. Conservative constant, never zero.
   */
  envelope_overhead_tokens: number;
}

/**
 * The shipped default.
 *
 * Every ratio is 1.0 tokens per byte, which is the proven bound. Nothing here
 * was measured, and the `provenance` field says so.
 */
export const PROVEN_TABLE: CalibrationTable = {
  id: "proven-utf8-bytes/1",
  provenance: "proven-upper-bound",
  safety_factor: 1,
  ratios: {
    ascii_alnum: 1,
    ascii_space: 1,
    ascii_punct: 1,
    latin1_supp: 1,
    multibyte: 1,
  },
  // A byte-level BPE adds at most a handful of control tokens around a
  // message. 8 is comfortably above every published value and costs nothing.
  envelope_overhead_tokens: 8,
};

export const TABLES: Record<string, CalibrationTable> = {
  proven: PROVEN_TABLE,
};

/** Bytes per class. Exported so the calibration harness measures the same split. */
export function classifyBytes(text: string): Record<CharClass, number> {
  const out: Record<CharClass, number> = {
    ascii_alnum: 0,
    ascii_space: 0,
    ascii_punct: 0,
    latin1_supp: 0,
    multibyte: 0,
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const bytes = Buffer.byteLength(ch, "utf8");
    if (cp < 0x80) {
      if ((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) out.ascii_alnum += bytes;
      else if (cp === 32 || cp === 9 || cp === 10 || cp === 13) out.ascii_space += bytes;
      else out.ascii_punct += bytes;
    } else if (cp < 0x100) {
      out.latin1_supp += bytes;
    } else {
      out.multibyte += bytes;
    }
  }
  return out;
}

export interface Estimate {
  tokens: number;
  tokenizer_id: string;
  table_id: string;
  /** True whenever the value is a bound rather than a measured count. */
  conservative_fallback: boolean;
  bytes: number;
}

/**
 * The conservative bound. Pure, synchronous, no network, no model.
 *
 * `Math.ceil` per class rather than on the sum: rounding each class up
 * separately can only raise the total, and raising is the safe direction.
 */
export function estimate(text: string, table: CalibrationTable = PROVEN_TABLE): Estimate {
  const classes = classifyBytes(text);
  let tokens = table.envelope_overhead_tokens;
  for (const [cls, bytes] of Object.entries(classes) as Array<[CharClass, number]>) {
    if (bytes === 0) continue;
    tokens += Math.ceil(bytes * table.ratios[cls] * table.safety_factor);
  }
  return {
    tokens,
    tokenizer_id: TOKENIZER_ID,
    table_id: table.id,
    conservative_fallback: true,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

/** Bare number, for the hot path inside the packet builder. */
export function estimateTokensConservative(text: string, table: CalibrationTable = PROVEN_TABLE): number {
  return estimate(text, table).tokens;
}

/**
 * Exact count via the Anthropic count-tokens API.
 *
 * Refuses unless `allow_network` is explicitly passed AND `ANTHROPIC_API_KEY`
 * is set, so a test can never reach the network by forgetting a flag. Returns
 * `null` rather than throwing when unavailable — an exact count is an
 * optimisation, never a correctness dependency.
 */
export async function countExact(
  text: string,
  opts: { allow_network: boolean; model?: string } = { allow_network: false },
): Promise<{ tokens: number; tokenizer_id: string; conservative_fallback: false } | null> {
  if (!opts.allow_network) return null;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  /* c8 ignore start — network path, never exercised in tests */
  try {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as {
      default: new (o: { apiKey: string }) => {
        messages: { countTokens: (b: unknown) => Promise<{ input_tokens: number }> };
      };
    };
    const client = new mod.default({ apiKey: key });
    const model = opts.model ?? "claude-sonnet-4-5";
    const res = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: text }],
    });
    return { tokens: res.input_tokens, tokenizer_id: `anthropic-count-tokens/${model}`, conservative_fallback: false };
  } catch {
    return null;
  }
  /* c8 ignore stop */
}

/**
 * Build a calibration table from measured (reference, text) pairs.
 *
 * Exported so the harness and its test share one implementation. The ratio for
 * a class is the maximum over the corpus of `tokens / bytes` for documents
 * dominated by that class, times the safety factor — a max, never a mean,
 * because a mean undercounts half the corpus by construction.
 *
 * Any resulting ratio is clamped to the proven bound: a measurement can only
 * ever make the estimate TIGHTER, never looser than the proof allows.
 */
export function buildCalibrationTable(opts: {
  id: string;
  reference: string;
  corpus: { name: string; documents: number; bytes: number; sha256: string };
  safety_factor: number;
  /** Per-class observed maximum of tokens/byte. */
  observed_max: Partial<Record<CharClass, number>>;
  envelope_overhead_tokens: number;
}): CalibrationTable {
  const ratios = {} as Record<CharClass, number>;
  for (const cls of Object.keys(PROVEN_TABLE.ratios) as CharClass[]) {
    const observed = opts.observed_max[cls];
    const proven = PROVEN_TABLE.ratios[cls];
    ratios[cls] = observed === undefined ? proven : Math.min(proven, observed);
  }
  return {
    id: opts.id,
    provenance: "measured",
    reference: opts.reference,
    corpus: opts.corpus,
    safety_factor: opts.safety_factor,
    ratios,
    envelope_overhead_tokens: Math.max(opts.envelope_overhead_tokens, PROVEN_TABLE.envelope_overhead_tokens),
  };
}
