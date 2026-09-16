/**
 * Evidence classes (ADR §2.2, R03). The class is a property of the EVENT,
 * decided by the ingress that produced it — never by a caller-supplied field.
 */
import { z } from "zod";

export const EVIDENCE_CLASSES = [
  "human_ruling",
  "verified_observation",
  "reported_result",
  "human_statement",
  "proposal",
  "model_inference",
  "question",
  "legacy_unverified",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);

/** Authority rank used by the precedence rules (higher prevails). */
export const EVIDENCE_RANK: Record<EvidenceClass, number> = {
  human_ruling: 5,
  verified_observation: 4,
  reported_result: 3,
  human_statement: 3,
  proposal: 2,
  model_inference: 2,
  legacy_unverified: 2,
  question: 1,
};

/**
 * Which ingress may produce which class. A class outside its ingress's set is
 * rejected before storage (CLASS_NOT_ALLOWED_ON_INGRESS). `import` admits any
 * class syntactically, but `human_ruling` additionally requires a valid
 * signature by a known human principal (SIGNATURE_REQUIRED otherwise).
 */
export const INGRESSES = ["ceremony", "adapter", "connector", "mcp", "cli", "import", "migration"] as const;
export type Ingress = (typeof INGRESSES)[number];

export const ALLOWED_CLASSES_BY_INGRESS: Record<Ingress, ReadonlySet<EvidenceClass>> = {
  ceremony: new Set<EvidenceClass>(["human_ruling"]),
  adapter: new Set<EvidenceClass>([
    "human_statement",
    "verified_observation",
    "reported_result",
    "proposal",
    "model_inference",
    "question",
  ]),
  connector: new Set<EvidenceClass>(["verified_observation", "question"]),
  mcp: new Set<EvidenceClass>(["proposal", "model_inference", "question"]),
  cli: new Set<EvidenceClass>(["proposal", "model_inference", "question"]),
  import: new Set<EvidenceClass>(EVIDENCE_CLASSES),
  migration: new Set<EvidenceClass>(["legacy_unverified"]),
};

/** A successor may APPLY over a target only when its rank is not lower (ADR §4.3 rule 1). */
export function successorMayApply(target: EvidenceClass, successor: EvidenceClass): boolean {
  return EVIDENCE_RANK[successor] >= EVIDENCE_RANK[target];
}
