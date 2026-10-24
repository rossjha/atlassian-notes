import { h } from "./dom.ts";
import { icon } from "./icons.ts";

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
    const el = h("div", { class: "menu", role: "menu", "aria-label": `Options for view ${viewName}` },
      item(icon("pencilSquare", "menu-svg"), "Edit view", actions.onEdit),
      del,
    );
    document.body.append(el);
    const r = btn.getBoundingClientRect();
    el.style.setProperty("top", `${r.bottom + window.scrollY + 4}px`);
    // Right-align under the cog, which sits at the far right of the header.
    el.style.setProperty("left", `${Math.max(8, r.right + window.scrollX - el.offsetWidth)}px`);
    btn.setAttribute("aria-expanded", "true");
    openMenu = { el, anchor: btn };
    el.querySelector<HTMLElement>(".menu-item:not([disabled])")?.focus();
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
