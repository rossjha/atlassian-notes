import { BUILTIN_COLUMNS, type ColumnSetting, type ColumnsConfig, type View } from "../shared/types.ts";
import { h } from "./dom.ts";

const DEFAULT_LIMIT = 500;
const DEFAULT_SHOWN = new Set(["key", "summary", "status", "type", "priority", "assignee", "updated", "note", "groom"]);

/** Lower-case, hyphenated slug matching /^[a-z0-9-]+$/ (falls back to "view"). */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "view";
}

export function uniqueViewId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

function columnLabel(id: string, columns: ColumnsConfig): string {
  return BUILTIN_COLUMNS.find((c) => c.id === id)?.label ?? columns.custom[id]?.label ?? id;
}

/** The view's own column order, then any builtin/custom columns it doesn't mention (hidden unless new view). */
function initialColumns(view: View | null, columns: ColumnsConfig): ColumnSetting[] {
  const out: ColumnSetting[] = view ? view.columns.map((c) => ({ ...c })) : [];
  const have = new Set(out.map((c) => c.id));
  const all = [...BUILTIN_COLUMNS.map((c) => c.id), ...Object.keys(columns.custom)];
  for (const id of all) {
    if (have.has(id)) continue;
    const shown = view === null && (DEFAULT_SHOWN.has(id) || id in columns.custom);
    out.push(shown ? { id } : { id, hidden: true });
  }
  return out;
}

/**
 * Modal editor for a view (null = new view). onSave/onDelete may reject: the message is shown in the
 * dialog and the dialog stays open. A new view comes back with id = slug of its name; the caller makes it unique.
 * An existing view with no onDelete gets a disabled Delete button.
 */
export function openViewEditor(
  view: View | null,
  columns: ColumnsConfig,
  onSave: (v: View) => Promise<void> | void,
  onDelete?: () => Promise<void> | void,
): void {
  const cols = initialColumns(view, columns);
  const dialog = h("dialog", { class: "ve-dialog", "aria-label": view ? `Edit view ${view.name}` : "New view" }) as HTMLDialogElement;

  const name = h("input", { type: "text", class: "ve-input", id: "ve-name" }) as HTMLInputElement;
  name.value = view?.name ?? "";
  const jql = h("textarea", { class: "ve-input", id: "ve-jql", rows: "3" }) as HTMLTextAreaElement;
  jql.value = view?.jql ?? "";
  const limit = h("input", { type: "number", class: "ve-input ve-limit", id: "ve-limit", min: "1", max: "1000", step: "1" }) as HTMLInputElement;
  limit.value = String(view?.limit ?? DEFAULT_LIMIT);
  const message = h("div", { class: "editor-msg", role: "alert" });
  message.hidden = true;
  const colList = h("ul", { class: "ve-cols" });

  const showError = (text: string): void => {
    message.textContent = text;
    message.hidden = false;
  };

  const drawColumns = (): void => {
    colList.replaceChildren(...cols.map((c, i) => {
      const box = h("input", { type: "checkbox", "aria-label": `Show ${columnLabel(c.id, columns)}` }) as HTMLInputElement;
      box.checked = !c.hidden;
      box.addEventListener("change", () => {
        if (box.checked) delete c.hidden;
        else c.hidden = true;
      });
      const move = (delta: number): void => {
        const j = i + delta;
        if (j < 0 || j >= cols.length) return;
        [cols[i], cols[j]] = [cols[j]!, cols[i]!];
        drawColumns();
      };
      const up = h("button", { type: "button", class: "btn ve-move", "aria-label": `Move ${columnLabel(c.id, columns)} up`, onclick: () => move(-1) }, "↑");
      const down = h("button", { type: "button", class: "btn ve-move", "aria-label": `Move ${columnLabel(c.id, columns)} down`, onclick: () => move(1) }, "↓");
      if (i === 0) up.setAttribute("disabled", "");
      if (i === cols.length - 1) down.setAttribute("disabled", "");
      let display: HTMLElement | null = null;
      if (c.id === "note" || c.id === "groom") {
        const sel = h("select", { class: "ve-display", "aria-label": `${columnLabel(c.id, columns)} display` },
          h("option", { value: "truncate" }, "truncate"),
          h("option", { value: "expand" }, "expand"),
        ) as HTMLSelectElement;
        sel.value = c.display === "expand" ? "expand" : "truncate";
        sel.addEventListener("change", () => {
          c.display = sel.value === "expand" ? "expand" : "truncate";
        });
        display = sel;
      }
      return h("li", { class: "ve-col" },
        h("label", { class: "ve-col-label" }, box, h("span", {}, columnLabel(c.id, columns))),
        display,
        up,
        down,
      );
    }));
  };
  drawColumns();

  const busy = (on: boolean): void => {
    for (const b of dialog.querySelectorAll("button")) {
      if (on) b.setAttribute("disabled", "");
      else if (!b.hasAttribute("data-always-disabled")) b.removeAttribute("disabled");
    }
  };

  const run = async (fn: () => Promise<void> | void): Promise<void> => {
    message.hidden = true;
    busy(true);
    try {
      await fn();
      dialog.close();
    } catch (e) {
      showError((e as Error).message);
      busy(false);
      drawColumns();
    }
  };

  const save = (): void => {
    const nameV = name.value.trim();
    const jqlV = jql.value.trim();
    const limitV = Number(limit.value);
    if (!nameV) return showError("Name is required");
    if (!jqlV) return showError("JQL is required");
    if (!Number.isInteger(limitV) || limitV < 1 || limitV > 1000) return showError("Limit must be a whole number from 1 to 1000");
    const next: View = {
      id: view?.id ?? slugify(nameV),
      name: nameV,
      jql: jqlV,
      limit: limitV,
      columns: cols.map((c) => ({ ...c })),
      filters: view?.filters ?? {},
    };
    void run(() => onSave(next));
  };

  let confirming = false;
  const del = h("button", { type: "button", class: "btn ve-delete" }, "Delete");
  del.addEventListener("click", () => {
    if (!onDelete) return;
    if (!confirming) {
      confirming = true;
      del.textContent = "Confirm delete";
      del.classList.add("ve-danger");
      return;
    }
    void run(onDelete);
  });
  if (view && !onDelete) {
    del.setAttribute("disabled", "");
    del.setAttribute("data-always-disabled", "");
    del.title = "A view is required; this is the last one";
  }

  const cancel = h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel");
  const form = h("div", { class: "ve-form" },
    h("h2", { class: "ve-title" }, view ? "Edit view" : "New view"),
    h("label", { class: "ve-field", for: "ve-name" }, "Name"),
    name,
    h("label", { class: "ve-field", for: "ve-jql" }, "JQL"),
    jql,
    h("label", { class: "ve-field", for: "ve-limit" }, "Limit (1–1000)"),
    limit,
    h("div", { class: "ve-field" }, "Columns"),
    colList,
    message,
    h("div", { class: "ve-actions" },
      view ? del : null,
      h("span", { class: "ve-spacer" }),
      cancel,
      h("button", { type: "button", class: "btn ve-primary", onclick: save }, "Save"),
    ),
  );
  dialog.append(form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
}
