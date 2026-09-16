/**
 * Host capability matrices — the machine-readable form of what each host can
 * and cannot do (R11, R20; C15 D1-CAPABILITY-MATRIX / D2-UNSUPPORTED-NOT-COVERED).
 *
 * These tables are the SOURCE OF RECORD for the two docs in
 * docs/operations/hosts-*.md: a test renders them and asserts the doc matches,
 * so a capability claim cannot drift from the code that relies on it.
 *
 * Honesty rules encoded here, not merely documented:
 *   - `injects: false` means the host gives the hook no channel to put text in
 *     front of the model. It is NEVER compensated for by injecting somewhere
 *     else and calling the event covered (`cross_backend_substitution` is a
 *     defect, C15 D2).
 *   - `cannotObserve` names what this host never tells us at all — reported as
 *     an uncaptured gap, never as coverage.
 */

export interface HostEventCapability {
  /** Host's own event name. */
  event: string;
  /** Fields the adapter captures from this event's input payload. */
  captures: string[];
  /** Can the hook put text in front of the model on this event? */
  injects: boolean;
  /** The host field that carries injected text, when it can. */
  channel: string | null;
  /** Twining event kind(s) this hook writes. */
  writes: string[];
  /** Does the adapter write a delivery receipt for this event? */
  receipt: "injected" | "projected" | "task_acked" | null;
  /** Stated plainly when the host cannot do something we would want. */
  note?: string;
}

export interface HostCapabilityMatrix {
  host: string;
  version: string;
  /** Lifecycle points this adapter covers. */
  captures: string[];
  /** Events through which this adapter can inject. */
  injects: string[];
  /** What this host never exposes — reported as gaps, never as coverage. */
  cannotObserve: string[];
  events: HostEventCapability[];
}

/** C15 A2-NO-PROSE: none of these may appear in a payload delivered to a model. */
export const FORBIDDEN_PROSE_REMINDERS = [
  "remember to call",
  "before committing you must record",
  "you MUST call",
  "do not forget to record",
  "Gate 1",
  "Gate 2",
  "call the memory tool first",
] as const;

/**
 * Assert an injected payload carries no prose reminder. Capture must be
 * hook-driven; if it only works because the model was nagged into it, it is
 * not capture (C15's PROSE-REMINDER FALLBACK ON control).
 */
export function findProseReminders(text: string): string[] {
  const hits: string[] = [];
  for (const needle of FORBIDDEN_PROSE_REMINDERS) {
    if (text.includes(needle)) hits.push(needle);
  }
  return hits;
}

/** A capture gap the host cannot close — reported, never papered over. */
export interface CoverageGap {
  kind: string;
  observed_at: string;
  captured: false;
  status: "uncaptured_event_gap";
}

export interface CoverageReport {
  host: string;
  required_lifecycle_points: number;
  captured: number;
  coverage: Record<string, "supported" | "unsupported">;
  gaps: CoverageGap[];
  /** Always empty: covering one host's gap with another host's evidence is a defect. */
  cross_backend_substitution_claims: never[];
  prose_reminders_injected: number;
}

/**
 * Render a matrix as the markdown table published in docs/operations/hosts-*.md.
 *
 * The doc is generated from this function and a test asserts the published
 * file still contains the rendered block byte-for-byte. That is the whole
 * point: a capability claim in prose drifts from the code that relies on it,
 * and a drifted claim about what a host can observe is exactly the kind of
 * thing nobody notices until a capture silently stops happening.
 */
export function renderMatrixTable(matrix: HostCapabilityMatrix): string {
  const lines: string[] = [];
  lines.push(`<!-- BEGIN GENERATED: ${matrix.host}@${matrix.version} — source of record is src/adapters/host-capability.ts consumers -->`);
  lines.push("");
  lines.push("| Event | Captured fields | Injects? | Channel | Twining events written | Receipt |");
  lines.push("|---|---|---|---|---|---|");
  for (const e of matrix.events) {
    lines.push(
      `| \`${e.event}\` | ${e.captures.length > 0 ? e.captures.map((c) => `\`${c}\``).join(", ") : "—"} ` +
        `| ${e.injects ? "yes" : "**no**"} | ${e.channel ? `\`${e.channel}\`` : "—"} ` +
        `| ${e.writes.length > 0 ? e.writes.map((w) => `\`${w}\``).join(", ") : "—"} ` +
        `| ${e.receipt ? `\`${e.receipt}\`` : "—"} |`,
    );
  }
  lines.push("");
  lines.push(`**Captures:** ${matrix.captures.join(", ")}`);
  lines.push("");
  lines.push(`**Injects on:** ${matrix.injects.join(", ")}`);
  lines.push("");
  lines.push(
    `**Cannot observe:** ${matrix.cannotObserve.length > 0 ? matrix.cannotObserve.map((c) => `\n- ${c}`).join("") : "nothing known"}`,
  );
  lines.push("");
  lines.push("**Per-event notes**");
  lines.push("");
  for (const e of matrix.events) {
    if (e.note) lines.push(`- \`${e.event}\` — ${e.note}`);
  }
  lines.push("");
  lines.push("<!-- END GENERATED -->");
  return lines.join("\n");
}
