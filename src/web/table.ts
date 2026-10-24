import { BUILTIN_COLUMNS, type ColumnSetting, type ColumnsConfig, type Row, type View } from "../shared/types.ts";
import { renderCell } from "./cells.ts";
import { h } from "./dom.ts";

export interface TableHandlers {
  onOpen(key: string): void;
  onSort(columnId: string): void;
  onNoteSaved(): void;
}

export interface SortState {
  columnId: string;
  dir: "asc" | "desc";
}

function label(id: string, columns: ColumnsConfig): string {
  return BUILTIN_COLUMNS.find((c) => c.id === id)?.label ?? columns.custom[id]?.label ?? id;
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
  const head = h("tr", {},
    ...visible.map((c) => {
      const active = sort?.columnId === c.id;
      return h("th", { class: `col-${c.id}${active ? " sorted" : ""}`, "aria-sort": active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none" },
        h("button", { type: "button", class: "th-btn", onclick: () => handlers.onSort(c.id) },
          label(c.id, columns),
          active ? h("span", { class: "sort-ind" }, sort!.dir === "asc" ? " ▲" : " ▼") : null,
        ),
      );
    }),
  );
  const body = h("tbody", {},
    ...rows.map((row) =>
      h("tr", {}, ...visible.map((c) => h("td", { class: `col-${c.id}` }, renderCell(row, c, columns)))),
    ),
  );
  const table = h("table", { class: "grid" }, h("thead", {}, head), body);
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
