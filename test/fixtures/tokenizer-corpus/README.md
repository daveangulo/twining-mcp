# Tokenizer calibration corpus

Input to `scripts/calibrate-tokenizer.mjs`. Each file should be DOMINATED by one
character class (>= 80% of its bytes), because a mixed document cannot tighten
any single class's ratio without assuming how its tokens split.

Classes, matching `classifyBytes` in `src/retrieval/tokenizer.ts`:
`ascii_alnum`, `ascii_space`, `ascii_punct`, `latin1_supp`, `multibyte`.

The files here are small, permissively-worded samples written for this purpose.
Add more before running a calibration that will be shipped — a five-document
corpus is enough to exercise the harness, not enough to bound production text.

No calibrated table is checked in today: this environment has no
`ANTHROPIC_API_KEY`, and emitting ratios without a measurement behind them is
exactly the fabrication the conservative bound exists to prevent. The shipped
`PROVEN_TABLE` is correct (and never undercounts) without this step.
