/**
 * Shared DOM/format helpers for the ES-module dashboard views.
 * Mirrors the helpers in app.js (which remain there until the legacy
 * renderers are fully retired); all user content goes through
 * textContent/createElement — never innerHTML.
 */

export function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = textContent;
  return node;
}

export function clearElement(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

export function formatTimestamp(ts) {
  if (!ts || ts === "none") return "--";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export function dayLabel(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function truncate(str, len) {
  if (!str) return "";
  return str.length <= len ? str : str.slice(0, len) + "...";
}

export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
