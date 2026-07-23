/**
 * URL linkification for dashboard text. DOM construction only — never
 * innerHTML — so entry/decision content cannot inject markup. File paths are
 * deliberately not linkified: a served page cannot open local files, and a
 * raw-file route is a server-surface decision (TRIAGE-SPEC §8), not a
 * rendering tweak.
 */

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/**
 * Split text into segments: { type: "text" | "url", value }.
 * Trailing sentence punctuation is not part of the URL.
 */
export function splitUrls(text) {
  const s = String(text ?? "");
  const segments = [];
  let last = 0;
  for (const match of s.matchAll(URL_RE)) {
    let url = match[0];
    const punct = url.match(TRAILING_PUNCT_RE);
    if (punct) url = url.slice(0, -punct[0].length);
    if (match.index > last) segments.push({ type: "text", value: s.slice(last, match.index) });
    segments.push({ type: "url", value: url });
    last = match.index + url.length;
  }
  if (last < s.length) segments.push({ type: "text", value: s.slice(last) });
  return segments;
}

/**
 * Append text to a node with http(s) URLs as new-tab links. Anchor clicks
 * stop propagation so links inside clickable rows don't also fire the row's
 * onSelect.
 */
export function linkifyInto(node, text) {
  for (const seg of splitUrls(text)) {
    if (seg.type === "url") {
      const a = document.createElement("a");
      a.href = seg.value;
      a.textContent = seg.value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.addEventListener("click", (e) => e.stopPropagation());
      node.appendChild(a);
    } else {
      node.appendChild(document.createTextNode(seg.value));
    }
  }
}
