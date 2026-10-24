import type { ColumnsConfig, CustomColumnDef, FilterValue, Filters, View } from "../shared/types.ts";
import { h } from "./dom.ts";

/** Which popover is open: "add" (the column menu), a custom column id, or none. Survives re-renders. */
let openPop: string | null = null;
let rerender: (() => void) | null = null;

document.addEventListener("click", (e) => {
  if (openPop === null) return;
  if ((e.target as Element | null)?.closest("[data-fb-keep]")) return;
  openPop = null;
  rerender?.();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || openPop === null) return;
  openPop = null;
  rerender?.();
});

function describe(f: FilterValue): string {
  switch (f.op) {
    case "oneOf": return f.values.join(", ");
    case "empty": return "is empty";
    case "notEmpty": return "is not empty";
    case "contains": return `contains "${f.text}"`;
  }
}

function isActive(f: FilterValue): boolean {
  return !(f.op === "oneOf" && f.values.length === 0) && !(f.op === "contains" && f.text === "");
}

export function renderFilterBar(
  container: HTMLElement,
  view: View,
  columns: ColumnsConfig,
  totals: { shown: number; total: number },
  onChange: (filters: Filters) => void,
): void {
  const draw = (): void => renderFilterBar(container, view, columns, totals, onChange);
  rerender = draw;
  const custom = Object.entries(columns.custom);
  const activeEntries = Object.entries(view.filters).filter(([id, f]) => columns.custom[id] && isActive(f));

  const change = (id: string, next: FilterValue | null): void => {
    const filters: Filters = { ...view.filters };
    if (next === null) delete filters[id];
    else filters[id] = next;
    onChange(filters);
  };

  const popover = (id: string, def: CustomColumnDef): HTMLElement => {
    const cur = view.filters[id];
    const items: HTMLElement[] = [];
    const check = (label: string, checked: boolean, onToggle: (on: boolean) => void): HTMLElement => {
      const box = h("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = checked;
      box.addEventListener("change", () => onToggle(box.checked));
      return h("label", { class: "fb-opt" }, box, h("span", {}, label));
    };
    if (def.type === "select") {
      const selected = cur?.op === "oneOf" ? cur.values : [];
      for (const opt of Object.keys(def.options)) {
        items.push(check(opt, selected.includes(opt), (on) => {
          const values = on ? [...selected, opt] : selected.filter((v) => v !== opt);
          change(id, values.length ? { op: "oneOf", values } : null);
        }));
      }
    } else {
      const input = h("input", { type: "text", class: "fb-text", placeholder: "contains…", "aria-label": `${def.label} contains` }) as HTMLInputElement;
      input.value = cur?.op === "contains" ? cur.text : "";
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") input.blur();
      });
      input.addEventListener("change", () => change(id, input.value.trim() ? { op: "contains", text: input.value.trim() } : null));
      items.push(input);
    }
    items.push(
      h("hr", { class: "fb-sep" }),
      check("is empty", cur?.op === "empty", (on) => change(id, on ? { op: "empty" } : null)),
      check("is not empty", cur?.op === "notEmpty", (on) => change(id, on ? { op: "notEmpty" } : null)),
    );
    const pop = h("div", { class: "fb-pop", role: "dialog", "aria-label": `Filter ${def.label}` }, ...items);
    pop.hidden = openPop !== id;
    return pop;
  };

  const toggle = (id: string): void => {
    openPop = openPop === id ? null : id;
    draw();
  };

  const chips = activeEntries.map(([id, f]) => {
    const def = columns.custom[id]!;
    return h("span", { class: "fb-wrap", "data-fb-keep": "" },
      h("span", { class: "fb-chip" },
        h("button", { type: "button", class: "fb-chip-label", "aria-label": `Edit ${def.label} filter`, onclick: () => toggle(id) },
          `${def.label}: ${describe(f)}`),
        h("button", { type: "button", class: "fb-chip-x", "aria-label": `Remove ${def.label} filter`, onclick: () => {
          if (openPop === id) openPop = null;
          change(id, null);
        } }, "×"),
      ),
      popover(id, def),
    );
  });

  const menu = h("div", { class: "fb-pop", role: "menu" },
    ...custom.map(([id, def]) =>
      h("button", { type: "button", class: "fb-menu-item", role: "menuitem", onclick: () => {
        openPop = id;
        draw();
      } }, def.label)),
  );
  menu.hidden = openPop !== "add";
  const addBtn = h("button", { type: "button", class: "btn", "aria-haspopup": "menu", onclick: () => toggle("add") }, "Add filter ▾");
  if (custom.length === 0) addBtn.setAttribute("disabled", "");

  // A column popover opened from the menu has no chip yet; anchor it to the Add filter button.
  const pendingCol = openPop && openPop !== "add" && !activeEntries.some(([id]) => id === openPop) ? columns.custom[openPop] : undefined;
  const adder = h("span", { class: "fb-wrap", "data-fb-keep": "" }, addBtn, menu, pendingCol ? popover(openPop!, pendingCol) : null);

  const clear = h("button", { type: "button", class: "link-btn", onclick: () => {
    openPop = null;
    onChange({});
  } }, "Clear filters");
  clear.hidden = activeEntries.length === 0;

  container.replaceChildren(
    adder,
    ...chips,
    clear,
    h("span", { class: "text-muted fb-count" }, `Showing ${totals.shown} of ${totals.total}`),
  );
}
