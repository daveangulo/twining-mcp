/**
 * URL linkification for dashboard text. DOM construction only — never
 * innerHTML — so entry/decision content cannot inject markup. File paths are
 * deliberately not linkified: a served page cannot open local files, and a
 * raw-file route is a server-surface decision (TRIAGE-SPEC §8), not a
 * rendering tweak.
 */

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
// Repo-relative file path: 1+ non-dotted segments, a final segment with a
// letter-led extension (so "pkg/6.1.1" and bare "src/" never match).
// Left boundary guard: a match may not begin mid-token (e.g. the tail of
// ".twining/config.yml" must not match as "twining/config.yml").
const REPO_PATH_RE = /(?<![\w./-])(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,7}/g;

/** Best-effort remote info ({ web_url, branch }) set once by main.js. */
let repoInfo = null;
export function setRepoInfo(info) {
  repoInfo = info && typeof info === "object" ? info : null;
}

/**
 * Remote blob URL for a repo-relative path (GitHub-style /blob/branch/path),
 * or null when no usable remote info. Best-effort: the target may not exist
 * until the branch is pushed — the local raw link stays authoritative.
 */
export function remoteBlobUrl(info, relPath) {
  if (!info || !info.web_url || !info.branch) return null;
  const encoded = String(relPath).split("/").map(encodeURIComponent).join("/");
  return `${info.web_url}/blob/${encodeURIComponent(info.branch)}/${encoded}`;
}

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

/** Split text into { type: "text" | "path", value } around repo-relative paths. */
export function splitRepoPaths(text) {
  const s = String(text ?? "");
  const segments = [];
  let last = 0;
  for (const match of s.matchAll(REPO_PATH_RE)) {
    if (match.index > last) segments.push({ type: "text", value: s.slice(last, match.index) });
    segments.push({ type: "path", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < s.length) segments.push({ type: "text", value: s.slice(last) });
  return segments;
}

/** URLs first, then repo paths within the remaining text segments. */
export function splitLinkable(text) {
  const out = [];
  for (const seg of splitUrls(text)) {
    if (seg.type === "url") out.push(seg);
    else out.push(...splitRepoPaths(seg.value));
  }
  return out;
}

/**
 * Append text to a node with http(s) URLs as new-tab links. Anchor clicks
 * stop propagation so links inside clickable rows don't also fire the row's
 * onSelect.
 */
export function linkifyInto(node, text) {
  const anchor = (href, label, title) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (title) a.title = title;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", (e) => e.stopPropagation());
    return a;
  };
  for (const seg of splitLinkable(text)) {
    if (seg.type === "url") {
      node.appendChild(anchor(seg.value, seg.value));
    } else if (seg.type === "path") {
      node.appendChild(
        anchor(`/api/raw?path=${encodeURIComponent(seg.value)}`, seg.value, "open local file (authoritative)"),
      );
      const remote = remoteBlobUrl(repoInfo, seg.value);
      if (remote) {
        node.appendChild(document.createTextNode(" "));
        node.appendChild(anchor(remote, "↗", "open on remote — may not exist until pushed"));
      }
    } else {
      node.appendChild(document.createTextNode(seg.value));
    }
  }
}
