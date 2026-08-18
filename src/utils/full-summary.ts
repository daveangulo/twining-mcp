/**
 * Render/response-time dedupe for the lossless truncation format (field
 * audit S4-1): when a summary was truncated at write time, its detail
 * begins with "Full summary: <full text>" where the full text extends the
 * truncated summary. Emitting both prints the same words twice — the field
 * measured roughly half of a warning-dense briefing, and 40/50 read
 * entries, as pure duplication. Guarded on the summary actually prefixing
 * the full text, so a caller-authored detail that merely starts with the
 * marker passes through untouched. Known miss (safe direction): a summary
 * containing a newline breaks the first-line comparison and falls back to
 * the old double render.
 */
export function dedupeFullSummary(
  summary: string,
  detail: string | undefined,
): { headline: string; detail: string } {
  const marker = "Full summary: ";
  if (!detail || !detail.startsWith(marker)) {
    return { headline: summary, detail: detail ?? "" };
  }
  const stripped = summary.endsWith("…") ? summary.slice(0, -1) : summary;
  const newlineIdx = detail.indexOf("\n");
  const firstLine = newlineIdx === -1 ? detail : detail.slice(0, newlineIdx);
  const fullText = firstLine.slice(marker.length);
  if (!fullText.startsWith(stripped)) {
    return { headline: summary, detail };
  }
  return {
    headline: fullText,
    detail: newlineIdx === -1 ? "" : detail.slice(newlineIdx + 1),
  };
}

/** Entry-shaped convenience: full text becomes the summary, the duplicated
 * first line leaves the detail. Applied in read/query/recent response
 * shaping (S4-1's read half; 2.16.0 pre-tag review ASC-2). */
export function dedupeEntryFullSummary<
  T extends { summary: string; detail?: string },
>(entry: T): T {
  const { headline, detail } = dedupeFullSummary(entry.summary, entry.detail);
  if (headline === entry.summary && detail === (entry.detail ?? "")) {
    return entry;
  }
  return { ...entry, summary: headline, detail };
}
