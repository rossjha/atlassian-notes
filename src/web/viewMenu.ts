import { h } from "./dom.ts";
import { icon } from "./icons.ts";
import { currentTheme, saveTheme, THEMES } from "./themes.ts";

export interface ViewMenuActions {
  onEdit(): void;
  onDelete(): void;
  /** When set, Delete is shown disabled with this reason as its tooltip. */
  deleteDisabledReason?: string;
}

let openMenu: { el: HTMLElement; anchor: HTMLElement } | null = null;

function closeMenu(returnFocus = false): void {
  if (!openMenu) return;
  const { el, anchor } = openMenu;
  openMenu = null;
  el.remove();
  anchor.setAttribute("aria-expanded", "false");
  if (returnFocus) anchor.focus();
}

document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.el.contains(e.target as Node) && !openMenu.anchor.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (openMenu && e.key === "Escape") {
    e.preventDefault();
    closeMenu(true);
  }
});
window.addEventListener("resize", () => closeMenu());

/** Opens `el` as the menu for `anchor`, right-aligned under it (both anchors sit at the far right of their bar). */
/** True while one of these menus is open (the drawer's Esc handler leaves Esc to the menu). */
export function isMenuOpen(): boolean {
  return openMenu !== null;
}

/** A text button that opens a simple menu of actions. */
export function menuButton(opts: { label: string; title: string; leadingIcon?: SVGSVGElement; items: { label: string; title?: string; onSelect: () => void }[] }): HTMLElement {
  const btn = h("button", {
    type: "button",
    class: "btn btn-icon",
    title: opts.title,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  }, opts.leadingIcon ?? null, opts.label, icon("chevronDown", "btn-svg btn-chevron"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenu?.anchor === btn) return closeMenu();
    closeMenu();
    const items = opts.items.map((it) =>
      h("button", { type: "button", role: "menuitem", class: "menu-item", title: it.title ?? it.label, onclick: () => { closeMenu(true); it.onSelect(); } }, it.label));
    showMenu(btn, h("div", { class: "menu", role: "menu", "aria-label": opts.title }, ...items));
  });
  return btn;
}

function showMenu(anchor: HTMLElement, el: HTMLElement, focus = ".menu-item:not([disabled])"): void {
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.setProperty("top", `${r.bottom + window.scrollY + 4}px`);
  el.style.setProperty("left", `${Math.max(8, r.right + window.scrollX - el.offsetWidth)}px`);
  anchor.setAttribute("aria-expanded", "true");
  openMenu = { el, anchor };
  el.querySelector<HTMLElement>(focus)?.focus();
}

/** The swatch button in the tab bar, opening a menu of the ten themes. */
export function themePickerButton(): HTMLElement {
  const btn = h("button", {
    type: "button",
    class: "icon-btn",
    title: "Theme",
    "aria-label": "Choose theme",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  }, icon("swatch", "icon-btn-svg"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenu?.anchor === btn) return closeMenu();
    closeMenu();
    const current = currentTheme();
    const items = THEMES.map((t) => {
      const chips = t.swatch.map((c) => {
        const chip = h("span", { class: "theme-chip" });
        chip.style.setProperty("--chip", c);
        return chip;
      });
      const on = t.id === current;
      return h("button", {
        type: "button",
        role: "menuitemradio",
        "aria-checked": String(on),
        class: `menu-item theme-item${on ? " theme-current" : ""}`,
        onclick: () => {
          saveTheme(t.id);
          closeMenu(true);
        },
      }, h("span", { class: "theme-swatch", "aria-hidden": "true" }, ...chips), h("span", { class: "theme-name" }, t.name), h("span", { class: "theme-check", "aria-hidden": "true" }, on ? "✓" : ""));
    });
    showMenu(btn, h("div", { class: "menu theme-menu", role: "menu", "aria-label": "Theme" }, ...items), ".theme-current");
  });
  return btn;
}

/** The settings cog in the view header, opening a small Edit / Delete menu for the active view. */
export function viewSettingsButton(viewName: string, actions: ViewMenuActions): HTMLElement {
  const btn = h("button", {
    type: "button",
    class: "icon-btn",
    title: "View settings",
    "aria-label": `Settings for view ${viewName}`,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  }, icon("cog6Tooth", "icon-btn-svg"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenu?.anchor === btn) return closeMenu();
    closeMenu();
    const item = (svg: SVGSVGElement, label: string, onclick: () => void, extra = "") =>
      h("button", { type: "button", role: "menuitem", class: `menu-item ${extra}`.trim(), onclick: () => { closeMenu(); onclick(); } }, svg, label);
    const del = item(icon("trash", "menu-svg"), "Delete view", actions.onDelete, "menu-danger");
    if (actions.deleteDisabledReason) {
      del.setAttribute("disabled", "");
      del.setAttribute("title", actions.deleteDisabledReason);
    }
    showMenu(btn, h("div", { class: "menu", role: "menu", "aria-label": `Options for view ${viewName}` },
      item(icon("pencilSquare", "menu-svg"), "Edit view", actions.onEdit),
      del,
    ));
  });
  return btn;
}

/** A modal confirm dialog. Resolves true only when the confirm button is pressed. */
export function confirmDialog(opts: { title: string; body: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "confirm-dialog", "aria-label": opts.title }) as HTMLDialogElement;
    let result = false;
    const cancel = h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel");
    const confirm = h("button", { type: "button", class: "btn btn-danger", onclick: () => { result = true; dialog.close(); } }, opts.confirmLabel);
    dialog.append(
      h("h2", { class: "confirm-title" }, opts.title),
      h("p", { class: "confirm-body" }, opts.body),
      h("div", { class: "confirm-actions" }, cancel, confirm),
    );
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus(); // the safe choice is the default
  });
}
