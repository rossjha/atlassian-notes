import { BUILTIN_COLUMNS, type ColumnSetting, type ColumnsConfig, type Row, type View } from "../shared/types.ts";
import { renderCell } from "./cells.ts";
import { applyColumnWidth, attachColumnControls, syncAllSized } from "./columnDrag.ts";
import { h } from "./dom.ts";
import { editCustom, editNote } from "./editors.ts";

export interface TableHandlers {
  onOpen(key: string): void;
  onSort(columnId: string): void;
  /** Omitted while views.yaml can't be saved: the toggle is then not shown. */
  onToggleDisplay?(columnId: string): void;
  onNoteSaved(): void;
  /** Both omitted while views.yaml can't be saved: no resize handles and no header dragging. */
  onResizeColumn?(columnId: string, width: number | null): void;
  onMoveColumn?(columnId: string, toVisibleIndex: number): void;
  /** Present when the personal board is available: adds a fixed first column of star toggles. */
  star?: { isStarred(key: string): boolean; toggle(key: string): void; disabled: boolean; locked?: boolean };
}

export interface SortState {
  columnId: string;
  dir: "asc" | "desc";
}

function label(id: string, columns: ColumnsConfig): string {
  return BUILTIN_COLUMNS.find((c) => c.id === id)?.label ?? columns.custom[id]?.label ?? columns.jiraColumns[id]?.label ?? id;
}

function starCell(key: string, star: NonNullable<TableHandlers["star"]>): HTMLElement {
  const on = star.isStarred(key);
  const btn = h("button", {
    type: "button",
    class: `star-btn${on ? " on" : ""}`,
    "aria-pressed": String(on),
    "aria-label": `Star ${key}`,
    title: star.disabled ? (star.locked ? "board.yaml has an error" : "Board unavailable") : on ? "Remove from Kanban" : "Add to Kanban",
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
    star ? h("th", { class: "col-star", "aria-label": "On Kanban" }, "★") : null,
    ...visible.map((c) => {
      const active = sort?.columnId === c.id;
      const th = h("th", { class: `col-${c.id}${active ? " sorted" : ""}`, "aria-sort": active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none" },
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
      applyColumnWidth([th], c.width);
      return th;
    }),
  );
  const body = h("tbody", {},
    ...rows.map((row) =>
      h("tr", {}, star ? starCell(row.ticket.key, star) : null, ...visible.map((c) => {
        const td = h("td", { class: `col-${c.id}` }, renderCell(row, c, columns));
        applyColumnWidth([td], c.width);
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
  // Layout: the table stays `table-layout: auto` so columns without a width keep sizing to their content.
  // A column with an explicit width gets `.col-sized` + `--col-w` on its th/td cells (see styles.css):
  // width = min-width = max-width = --col-w on the cells, and their content is capped to it, so the column's
  // min-content never exceeds --col-w and its specified width wins in both directions (wider than the
  // content too). Spare table width goes to the auto columns; when every column is sized the table drops
  // `width: 100%` (.all-sized) so it doesn't stretch them. Wider than the page scrolls in .table-wrap.
  // (table-layout: fixed would make widths stick too, but would split the rest evenly among auto columns.)
  const table = h("table", { class: "ticket-grid" }, h("thead", {}, head), body) as HTMLTableElement;
  syncAllSized(table);
  table.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("a[data-open]");
    if (!a) return;
    // plain click opens the drill-in; modified clicks fall through to the Jira link
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    handlers.onOpen(a.getAttribute("data-open")!);
  });
  container.replaceChildren(table);
  const { onResizeColumn, onMoveColumn } = handlers;
  if (onResizeColumn && onMoveColumn) {
    attachColumnControls(table, visible, star ? 1 : 0, (id) => label(id, columns), { onResize: onResizeColumn, onMove: onMoveColumn });
  }
  if (rows.length === 0) container.append(h("p", { class: "empty-state" }, "No tickets."));
}
