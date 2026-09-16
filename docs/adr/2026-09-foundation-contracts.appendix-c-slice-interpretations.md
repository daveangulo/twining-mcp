# Appendix C — Vertical slice interpretations and rulings (Stage 0)

Source: lane 02's slice report (2026-09-15) and the lead's rulings. Where the ADR text was corrected as a result, the body says so inline.

## Interpretations made by the slice (accepted)

1. `corrected` is class-ranked (§4.3 rule 1); §12's scenario was reworded so the governing correction is authored by the ruling's own human principal.
2. Admission order: parents and relation endpoints before capability; no-policy-yet is a retryable quarantine (§4.3.1).
3. `archived` is a flag beside an untouched status (§4.4).
4. `reinstated` refuses on revoked, tombstoned or retracted targets, recorded as a visible annotation; a reinstated record enters an explicit **conflict** with any still-applicable successor (this is the conflict machinery, not the `contested` annotation).
5. Partial-supersession containment ignores `revision` (`scopeEnvelopeCovers`); `scopeGoverns` stays the only authority test.
6. `query(mode: "lessons")` reads the same tenant and repo across all paths; it never crosses repo or tenant.
7. Per-replica delivery evidence lives in `store/receipts.jsonl` and survives loss of the projection database (C14 A-RCP3 permits `uncertain`; retaining is stricter).
8. C09: a record admitted in its author's scope may carry supersession claims that are rejected as unauthorized when authored outside that scope.

## Contract changes applied as draft.2

`local_persisted → admitted` transition; quarantine reasons `signer_unknown`, `no_policy_yet`; reject reason `unauthorized`; `CONFLICTING_DUPLICATE` validation code; `corrected.by`; `parts` on `revoked`/`overridden`; per-part `scope`; `parts` and `requirements` on rulings; `propose` role; `ProjectedRecord.evidence_class` typed.

## Known limits carried as todo (12)

Injection receipts (C09 A20, C10 A11 — lane 03/04); the Git arm and N10 of C14 (lane 02 carrier); offline "incomplete" labels (C14 A-CUR5/N8 — lane 04); per-part evidence class/version projections and part-level revocation (C16 L1–L4, A3.4 — lane 02 on draft.2 contracts); the C09 OQ-5 admitted-contested variant.
