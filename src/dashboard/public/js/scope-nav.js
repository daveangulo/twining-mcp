/**
 * Scope breadcrumb — replaces the free-text header scope input.
 * project root ▸ src/ ▸ dashboard/ … each level opens a dropdown of child
 * scopes with record counts (computed from the client index store), plus a
 * free-text row for power use. Emits the active scope through onChange.
 */
import { el, clearElement, debounce } from "./util.js";

export function createScopeNav(host, { store, onChange }) {
  let scope = ""; // "" = all
  let openMenu = null;

  function setScope(next) {
    scope = next;
    render();
    onChange(scope);
  }

  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
  }

  function openDropdown(anchorEl, prefix) {
    closeMenu();
    const menu = el("div", "sn-menu");
    const children = store.scopeChildren({}, prefix);
    if (prefix) {
      const up = el("button", "sn-item", "⟵ clear to here");
      up.type = "button";
      up.addEventListener("click", () => { closeMenu(); setScope(prefix); });
      menu.appendChild(up);
    }
    const all = el("button", "sn-item", prefix ? "⟵ all scopes" : "all scopes");
    all.type = "button";
    all.addEventListener("click", () => { closeMenu(); setScope(""); });
    menu.appendChild(all);
    for (const child of children.slice(0, 30)) {
      const item = el("button", "sn-item");
      item.type = "button";
      item.appendChild(el("span", "sn-seg", child.segment));
      item.appendChild(el("span", "sn-count", String(child.count)));
      item.addEventListener("click", () => { closeMenu(); setScope(child.scope); });
      menu.appendChild(item);
    }
    const free = el("input", "sn-free");
    free.type = "text";
    free.placeholder = "custom prefix…";
    free.value = scope;
    free.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") { closeMenu(); setScope(free.value.trim()); }
      if (evt.key === "Escape") closeMenu();
    });
    menu.appendChild(free);
    anchorEl.appendChild(menu);
    openMenu = menu;
    free.focus();
  }

  document.addEventListener("click", (evt) => {
    if (openMenu && !host.contains(evt.target)) closeMenu();
  });

  function render() {
    clearElement(host);
    const rootBtn = el("button", "sn-crumb" + (scope === "" ? " active" : ""), "all");
    rootBtn.type = "button";
    rootBtn.addEventListener("click", (evt) => { evt.stopPropagation(); openDropdown(rootBtn, ""); });
    host.appendChild(rootBtn);

    // Build cumulative segment crumbs: "src/dashboard/" -> ["src/", "src/dashboard/"]
    let prefix = "";
    const segments = [];
    if (scope) {
      const parts = scope.endsWith("/") ? scope.slice(0, -1).split("/") : scope.split("/");
      for (const [i, part] of parts.entries()) {
        const isLast = i === parts.length - 1;
        const seg = part + (scope.endsWith("/") || !isLast ? "/" : "");
        prefix += seg;
        segments.push({ label: seg, prefix });
      }
    }
    for (const seg of segments) {
      host.appendChild(el("span", "sn-sep", "▸"));
      const crumb = el("button", "sn-crumb", seg.label);
      crumb.type = "button";
      const p = seg.prefix;
      crumb.addEventListener("click", (evt) => { evt.stopPropagation(); openDropdown(crumb, p); });
      host.appendChild(crumb);
    }
  }

  store.subscribe(debounce(render, 500)); // counts refresh lazily on data change
  render();

  return { setScope, getScope: () => scope };
}
