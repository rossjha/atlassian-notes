import { BUILTIN_COLUMNS, type ColumnSetting, type ColumnsConfig, type Row, type View } from "../shared/types.ts";
import { renderCell } from "./cells.ts";
import { h } from "./dom.ts";
import { editCustom, editNote } from "./editors.ts";

export interface TableHandlers {
  onOpen(key: string): void;
  onSort(columnId: string): void;
  /** Omitted while views.yaml can't be saved: the toggle is then not shown. */
  onToggleDisplay?(columnId: string): void;
  onNoteSaved(): void;
  /** Present when the personal board is available: adds a fixed first column of star toggles. */
  star?: { isStarred(key: string): boolean; toggle(key: string): void; disabled: boolean; locked?: boolean };
}

export interface SortState {
  columnId: string;
  dir: "asc" | "desc";
}

function label(id: string, columns: ColumnsConfig): string {
  return BUILTIN_COLUMNS.find((c) => c.id === id)?.label ?? columns.custom[id]?.label ?? id;
}

function starCell(key: string, star: NonNullable<TableHandlers["star"]>): HTMLElement {
  const on = star.isStarred(key);
  const btn = h("button", {
    type: "button",
    class: `star-btn${on ? " on" : ""}`,
    "aria-pressed": String(on),
    "aria-label": `Star ${key}`,
    title: star.disabled ? (star.locked ? "board.yaml has an error" : "Board unavailable") : on ? "Remove from my board" : "Add to my board",
    onclick: (e: Event) => {
      e.stopPropagation();
      star.toggle(key);
    },
  }, on ? "★" : "☆");
  if (star.disabled) btn.setAttribute("disabled", "");
  return h("td", { class: "col-star" }, btn);
}

export function renderTable(
  container: HTMLElement,
  view: View,
  rows: Row[],
  columns: ColumnsConfig,
  handlers: TableHandlers,
  sort: SortState | null = null,
): void {
  const visible: ColumnSetting[] = view.columns.filter((c) => !c.hidden);
  const star = handlers.star;
  const head = h("tr", {},
    star ? h("th", { class: "col-star", "aria-label": "My board" }, "★") : null,
    ...visible.map((c) => {
      const active = sort?.columnId === c.id;
      return h("th", { class: `col-${c.id}${active ? " sorted" : ""}`, "aria-sort": active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none" },
        h("div", { class: "th-inner" },
          h("button", { type: "button", class: "th-btn", onclick: () => handlers.onSort(c.id) },
            label(c.id, columns),
            active ? h("span", { class: "sort-ind" }, sort!.dir === "asc" ? " ▲" : " ▼") : null,
          ),
          (c.id === "note" || c.id === "groom") && handlers.onToggleDisplay
            ? h("button", {
                type: "button",
                class: "display-toggle",
                title: c.display === "expand" ? "Showing full text; click to truncate" : "Truncated; click to show full text",
                "aria-label": `${label(c.id, columns)} column: ${c.display === "expand" ? "expanded" : "truncated"}`,
                onclick: () => handlers.onToggleDisplay?.(c.id),
              }, c.display === "expand" ? "▤" : "▭")
            : null,
        ),
      );
    }),
  );
  const body = h("tbody", {},
    ...rows.map((row) =>
      h("tr", {}, star ? starCell(row.ticket.key, star) : null, ...visible.map((c) => {
        const td = h("td", { class: `col-${c.id}` }, renderCell(row, c, columns));
        const custom = columns.custom[c.id];
        const rerender = (): void => {
          td.replaceChildren(renderCell(row, c, columns));
          handlers.onNoteSaved();
        };
        if (c.id === "note") {
          td.classList.add("editable");
          td.addEventListener("click", (e) => {
            if (td.querySelector(".editor-wrap") || (e.target as Element).closest("a,button")) return;
            editNote(td, row, rerender);
          });
        } else if (custom) {
          td.classList.add("editable");
          td.addEventListener("click", () => {
            if (td.querySelector(".editor-wrap")) return;
            editCustom(td, row, c.id, custom, rerender);
          });
        }
        return td;
      })),
    ),
  );
  const table = h("table", { class: "ticket-grid" }, h("thead", {}, head), body);
  table.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("a[data-open]");
    if (!a) return;
    // plain click opens the drill-in; modified clicks fall through to the Jira link
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    handlers.onOpen(a.getAttribute("data-open")!);
  });
  container.replaceChildren(table);
  if (rows.length === 0) container.append(h("p", { class: "empty-state" }, "No tickets."));
}
