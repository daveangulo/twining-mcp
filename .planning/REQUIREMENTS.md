# Requirements: Twining MCP

**Defined:** 2026-03-02
**Core Value:** Agents share *why* decisions were made, not just *what* was done -- eliminating the information silos that degrade multi-agent coding workflows across context windows.

## v1.4 Requirements

Requirements for v1.4 Agent Behavior Quality. Each maps to roadmap phases.

### Behavioral Specification

- [x] **SPEC-01**: plugin/BEHAVIORS.md contains behavioral rules (MUST/SHOULD/MUST_NOT) for all 32 MCP tools
- [x] **SPEC-02**: Each tool has usage context, correct usage examples, and incorrect usage examples
- [x] **SPEC-03**: 8+ workflow scenarios define expected multi-tool sequences for common patterns (orient->work->decide->verify, coordination, handoff, etc.)
- [x] **SPEC-04**: Anti-pattern catalog documents when NOT to use Twining and what constitutes misuse
- [x] **SPEC-05**: Tools tiered by importance (Tier 1 core, Tier 2 supporting) with proportional spec depth
- [x] **SPEC-06**: Spec uses structured markdown conventions that are machine-parseable by the eval harness

### Data Quality

- [x] **QUAL-01**: Per-tool quality criteria define what "good" parameter content looks like vs. garbage
- [x] **QUAL-02**: Scope precision rules defined (narrowest-fit path prefix, never "project" when more specific exists)
- [x] **QUAL-03**: Rationale quality criteria defined (must reference alternatives, must be specific enough to be useful in future sessions)
- [x] **QUAL-04**: Quality anti-patterns documented (vague rationale, overly broad scope, missing context, redundant entries)

### Evaluation Harness

- [x] **EVAL-01**: Synthetic scenario engine loads YAML definitions and runs through scorer pipeline
- [ ] **EVAL-02**: 7+ deterministic scorers check structural behavioral patterns (sequencing, arguments, ordering)
- [ ] **EVAL-03**: 2 LLM-as-judge scorers evaluate semantic quality (rationale specificity, scope appropriateness)
- [ ] **EVAL-04**: Transcript parser extracts twining_* tool calls from Claude Code JSONL session logs
- [ ] **EVAL-05**: Same scorers work on both synthetic scenarios and real transcripts
- [ ] **EVAL-06**: LLM judge behind TWINING_EVAL_JUDGE=1 env-var gate, local-only
- [ ] **EVAL-07**: Multiple trials (k>=3) for non-deterministic scenarios
- [ ] **EVAL-08**: 20+ synthetic scenarios across all workflow categories
- [x] **EVAL-09**: Separate vitest config (vitest.config.eval.ts) and npm scripts (eval, eval:synthetic, eval:transcript)

### Plugin Tuning

- [ ] **TUNE-01**: Skills/hooks/agents iteratively updated based on eval failures
- [ ] **TUNE-02**: Tuned plugin passes eval suite at defined score thresholds
- [ ] **TUNE-03**: Regression baseline JSON captures eval scores for future CI comparison
- [ ] **TUNE-04**: Plugin token budget tracked; prompt growth stays under 20% cap
- [ ] **TUNE-05**: Holdout eval set validates tuning doesn't overfit (Goodhart's Law mitigation)

## Future Requirements

### Eval Expansion

- **EVAL-10**: Coverage matrix tracking which tools and workflows have eval scenarios
- **EVAL-11**: Comparative eval runs automating plugin version-to-version comparison
- **EVAL-12**: Visual eval dashboard for browsing results beyond terminal output
- **EVAL-13**: CI gate blocking plugin PRs that regress eval scores

### Cross-Model Validation

- **MODEL-01**: Behavioral compliance testing across model tiers (Opus vs Sonnet vs Haiku)
- **MODEL-02**: Model-specific tuning recommendations based on compliance variance

## Out of Scope

| Feature | Reason |
|---------|--------|
| Eval dashboard UI | vitest terminal output sufficient for v1.4; visual dashboard is post-v1.4 |
| CI-blocking eval gate | Establish baselines first; CI gate after scores stabilize |
| Model training / fine-tuning | Plugin tuning modifies prompt text, not model weights |
| Real-time session monitoring | Eval is offline analysis, not live observation |
| Autonomous plugin fix loops | Human reviews eval results and decides changes |
| Remaining 22 tool deep specs | All 32 get coverage, but Tier 2 tools get lighter treatment; deep expansion is post-v1.4 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SPEC-01 | Phase 15 | Complete |
| SPEC-02 | Phase 15 | Complete |
| SPEC-03 | Phase 15 | Complete |
| SPEC-04 | Phase 15 | Complete |
| SPEC-05 | Phase 15 | Complete |
| SPEC-06 | Phase 15 | Complete |
| QUAL-01 | Phase 15 | Complete |
| QUAL-02 | Phase 15 | Complete |
| QUAL-03 | Phase 15 | Complete |
| QUAL-04 | Phase 15 | Complete |
| EVAL-01 | Phase 16 | Complete |
| EVAL-02 | Phase 16 | Pending |
| EVAL-03 | Phase 18 | Pending |
| EVAL-04 | Phase 17 | Pending |
| EVAL-05 | Phase 17 | Pending |
| EVAL-06 | Phase 18 | Pending |
| EVAL-07 | Phase 18 | Pending |
| EVAL-08 | Phase 16 | Pending |
| EVAL-09 | Phase 16 | Complete |
| TUNE-01 | Phase 19 | Pending |
| TUNE-02 | Phase 19 | Pending |
| TUNE-03 | Phase 19 | Pending |
| TUNE-04 | Phase 19 | Pending |
| TUNE-05 | Phase 19 | Pending |

**Coverage:**
- v1.4 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after roadmap creation*
