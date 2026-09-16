/**
 * Measured comparison: scoped semantic recall vs lexical/exact, on a synthetic
 * fixture (lane 04 brief, item 6).
 *
 * This reports NUMBERS, not claims. The question it answers is narrow and
 * specific:
 *
 *   When the scope gate runs BEFORE ranking, what happens to recall?
 *
 * The concern a reviewer should have about lane 04 is that hard scope filtering
 * buys safety by throwing away useful recall. The measurement below separates
 * the two effects:
 *
 *  - **in-scope recall** — of the relevant records the principal MAY read, how
 *    many does each method find? This is the number that must not degrade.
 *  - **leakage** — of the records the principal may NOT read, how many does
 *    each method return? This is the number the lane exists to drive to zero.
 *
 * The fixture is synthetic and small, so the absolute numbers are not a
 * benchmark. What is load-bearing is the SHAPE, and the measured run is:
 *
 *   corpus=24 docs (12 readable / 12 not), relevant+readable=6, K=6
 *     lexical,  ungated   in_scope_recall=0.33  leaked=4  precision=1.00
 *     lexical,  GATED     in_scope_recall=0.67  leaked=0  precision=0.67
 *     semantic, ungated   in_scope_recall=0.17  leaked=5  precision=1.00
 *     semantic, GATED     in_scope_recall=1.00  leaked=0  precision=1.00
 *     exact,    GATED     in_scope_recall=0.17  leaked=0  precision=0.17
 *
 * Two things to read off it:
 *
 *  1. Gating does not cost in-scope recall — it RAISES it, because the ungated
 *     runs spend their top-K slots on unreadable bait. The gate removes only
 *     documents that were never admissible answers, so it can never lower the
 *     number; here it roughly doubles (lexical) or sextuples (semantic) it.
 *  2. Scoped semantic still beats scoped lexical and scoped exact, so the
 *     lane's hard filter does not push the system back toward exact match.
 *     That is the trade the whole design rests on and it is measured, not
 *     asserted.
 */
import { describe, it, expect } from "vitest";
import { selectCandidates, type SelectionRequest } from "../../src/retrieval/select.js";
import type { Scope } from "../../src/contracts/scope.js";

const REPO_A = "r_aaa00000000000000000000000";
const REPO_B = "r_bbb00000000000000000000000";
const T = "t_ttt00000000000000000000000";

interface Doc {
  id: string;
  scope: Scope;
  text: string;
  /** Ground truth: is this document relevant to the query? */
  relevant: boolean;
  /** Ground truth: may the querying principal read it? */
  readable: boolean;
}

const QUERY_TERMS = ["retry", "backoff", "duplicate", "charge", "timeout"];

/** A deliberately naive lexical scorer: term overlap. Stands in for BM25. */
function lexicalScore(text: string): number {
  const words = new Set(text.toLowerCase().split(/\W+/));
  return QUERY_TERMS.filter((t) => words.has(t)).length / QUERY_TERMS.length;
}

/**
 * A stand-in for a dense retriever: term overlap PLUS credit for paraphrase
 * vocabulary that shares no literal token with the query. This is the property
 * that makes semantic retrieval worth having, and the property that makes
 * out-of-scope bait dangerous — a paraphrase in another repo outscores a
 * literal match in your own.
 */
const PARAPHRASE = ["exponential", "redelivery", "double", "billing", "deadline", "repeat"];
function semanticScore(text: string): number {
  const words = new Set(text.toLowerCase().split(/\W+/));
  const literal = QUERY_TERMS.filter((t) => words.has(t)).length;
  const para = PARAPHRASE.filter((t) => words.has(t)).length;
  return Math.min(1, (literal + 0.8 * para) / QUERY_TERMS.length);
}

/** 24 documents: 12 readable, 12 not; relevance is independent of readability. */
function corpus(): Doc[] {
  const docs: Doc[] = [];
  const mk = (n: number, scope: Scope, readable: boolean, text: string, relevant: boolean) =>
    docs.push({ id: `${readable ? "in" : "out"}-${n}`, scope, text, relevant, readable });

  const IN: Scope = { tenant: T, repo: REPO_A, path: "gateway/retry" };
  const OUT: Scope = { tenant: T, repo: REPO_B, path: "ledger/retry" };

  // Relevant + readable, literal wording (lexical finds these easily).
  mk(1, IN, true, "retry backoff causes duplicate charge on timeout", true);
  mk(2, IN, true, "duplicate charge after retry timeout", true);
  mk(3, IN, true, "retry storm and duplicate charge", true);
  // Relevant + readable, PARAPHRASED (lexical misses; semantic finds).
  mk(4, IN, true, "exponential redelivery produces double billing past the deadline", true);
  mk(5, IN, true, "repeat billing when the deadline elapses", true);
  mk(6, IN, true, "double charge from exponential redelivery", true);
  // Irrelevant + readable.
  for (let i = 7; i <= 12; i++) mk(i, IN, true, `gateway configuration note number ${i} about logging`, false);

  // Relevant + NOT readable — the bait. Deliberately the strongest matches.
  mk(13, OUT, false, "retry backoff causes duplicate charge on timeout exactly", true);
  mk(14, OUT, false, "exponential redelivery double billing repeat deadline", true);
  mk(15, OUT, false, "duplicate charge retry timeout backoff", true);
  mk(16, OUT, false, "repeat double billing deadline redelivery exponential", true);
  mk(17, OUT, false, "retry backoff duplicate charge timeout", true);
  mk(18, OUT, false, "timeout retry duplicate charge backoff", true);
  // Irrelevant + not readable.
  for (let i = 19; i <= 24; i++) mk(i, OUT, false, `ledger note ${i} about reconciliation`, false);

  return docs;
}

const REQ: SelectionRequest = {
  principal: "u-ana",
  authorized: [{ tenant: T, repo: REPO_A }],
  query: { tenant: T, repo: REPO_A, path: "gateway/retry" },
  mode: "strict",
};

/**
 * Rank by a scorer, take the top K, and report recall + leakage.
 *
 * Ties are broken ADVERSARIALLY: among equal scores, irrelevant documents sort
 * first. A first version of this used the array's natural order, and every
 * scorer — including a literal-exact one that scores the paraphrased documents
 * at zero — reported perfect recall, because the relevant documents happened to
 * be listed before the irrelevant ones. That measured the fixture's layout, not
 * the ranker. With adversarial ties, a scorer gets credit only for the
 * documents it actually ranks above the noise.
 */
function measure(
  docs: Doc[],
  score: (t: string) => number,
  k: number,
): { in_scope_recall: number; leaked: number; returned: number; precision: number } {
  const ranked = [...docs]
    .sort((a, b) => {
      const d = score(b.text) - score(a.text);
      if (d !== 0) return d;
      // Equal score: the irrelevant one wins the slot.
      return Number(a.relevant) - Number(b.relevant);
    })
    .slice(0, k);
  const relevantReadable = docs.filter((d) => d.relevant && d.readable).length;
  const foundRelevantReadable = ranked.filter((d) => d.relevant && d.readable).length;
  return {
    in_scope_recall: foundRelevantReadable / relevantReadable,
    leaked: ranked.filter((d) => !d.readable).length,
    returned: ranked.length,
    precision: ranked.filter((d) => d.relevant).length / Math.max(1, ranked.length),
  };
}

/** Same, but the gate runs FIRST — scope before ranking. */
function measureGated(
  docs: Doc[],
  score: (t: string) => number,
  k: number,
): ReturnType<typeof measure> {
  const gated = selectCandidates(docs, (d) => d.scope, (d) => d.id, REQ).admitted;
  return measure(gated, score, k);
}

describe("measured: scoped semantic recall vs lexical/exact", () => {
  const docs = corpus();
  const K = 6; // the number of relevant+readable documents in the fixture

  it("reports the numbers", () => {
    const rows = [
      ["lexical, ungated", measure(docs, lexicalScore, K)],
      ["lexical, GATED", measureGated(docs, lexicalScore, K)],
      ["semantic, ungated", measure(docs, semanticScore, K)],
      ["semantic, GATED", measureGated(docs, semanticScore, K)],
      ["exact (literal-only), GATED", measureGated(docs, (t) => (lexicalScore(t) === 1 ? 1 : 0), K)],
    ] as const;
    // eslint-disable-next-line no-console
    console.log(
      "\n[lane04-recall] corpus=24 docs (12 readable / 12 not), relevant+readable=6, K=6\n" +
        rows
          .map(
            ([name, m]) =>
              `  ${name.padEnd(30)} in_scope_recall=${m.in_scope_recall.toFixed(2)}  leaked=${m.leaked}  precision=${m.precision.toFixed(2)}`,
          )
          .join("\n"),
    );
    expect(rows).toHaveLength(5);
  });

  it("the gate drives leakage to zero on BOTH ranking methods", () => {
    expect(measure(docs, lexicalScore, K).leaked).toBeGreaterThan(0);
    expect(measure(docs, semanticScore, K).leaked).toBeGreaterThan(0);
    expect(measureGated(docs, lexicalScore, K).leaked).toBe(0);
    expect(measureGated(docs, semanticScore, K).leaked).toBe(0);
  });

  it("the gate does NOT cost in-scope recall — it is orthogonal to the ranker", () => {
    // The ungated run wastes its top-K slots on unreadable bait, so gating
    // actually RAISES in-scope recall at a fixed K. It can never lower it:
    // the gate removes only documents that were never admissible answers.
    for (const score of [lexicalScore, semanticScore]) {
      expect(measureGated(docs, score, K).in_scope_recall).toBeGreaterThanOrEqual(
        measure(docs, score, K).in_scope_recall,
      );
    }
  });

  it("scoped SEMANTIC beats scoped LEXICAL on the paraphrased half — the recall the lane preserves", () => {
    const sem = measureGated(docs, semanticScore, K);
    const lex = measureGated(docs, lexicalScore, K);
    expect(sem.in_scope_recall).toBeGreaterThan(lex.in_scope_recall);
    // Concretely: semantic finds all six; lexical finds only the three whose
    // wording literally overlaps the query, and the paraphrased half tie with
    // the irrelevant documents at score 0.
    expect(sem.in_scope_recall).toBe(1);
    // Measured: 4 of 6. The three literal matches, plus "double charge from
    // exponential redelivery", which happens to contain the query term
    // "charge". The two purely-paraphrased documents tie at zero with the
    // irrelevant ones and lose the slot under adversarial tie-breaking.
    expect(lex.in_scope_recall).toBeCloseTo(4 / 6, 5);
  });

  it("exact match is the weakest of the three, which is why the lane keeps semantic retrieval", () => {
    const exact = measureGated(docs, (t) => (lexicalScore(t) === 1 ? 1 : 0), K);
    expect(exact.in_scope_recall).toBeLessThan(measureGated(docs, semanticScore, K).in_scope_recall);
  });
});
