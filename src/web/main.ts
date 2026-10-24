import type { ColumnsConfig, LiveEvent, Row, View } from "../shared/types.ts";
import { applyFilters, sortRows } from "../shared/rowOps.ts";
import { api } from "./api.ts";
import { h, relativeTime } from "./dom.ts";
import { isEditing, onEditorsIdle } from "./editors.ts";
import { connectLive } from "./live.ts";
import { renderTable, type SortState, type TableHandlers } from "./table.ts";

const TAB_KEY = "atlassian-notes.activeTab";

let views: View[] = [];
let columns: ColumnsConfig | null = null;
let configError: string | null = null;
let activeId: string | null = null;
let rows: Row[] = [];
let fetchedAt: string | null = null;
let rowsError: string | null = null;
const refreshingIds = new Set<string>();
let rowsSeq = 0;
let sort: SortState | null = null;

const root = document.body;
const tabsEl = h("nav", { class: "tabs" });
const headerEl = h("div", { class: "view-header" });
const errorEl = h("div", { class: "error-bar", role: "alert" });
const tableEl = h("div", { class: "table-wrap" });
root.append(h("main", { class: "app" }, tabsEl, headerEl, errorEl, tableEl));

const handlers: TableHandlers = {
  onOpen(key) {
    // Placeholder until the drawer (Task 12): open the Jira page.
    const url = rows.find((r) => r.ticket.key === key)?.ticket.url;
    if (url) window.open(url, "_blank", "noopener");
  },
  onSort(columnId) {
    sort = sort?.columnId === columnId
      ? { columnId, dir: sort.dir === "asc" ? "desc" : "asc" }
      : { columnId, dir: "asc" };
    renderBody();
  },
  onToggleDisplay(columnId) {
    const view = activeView();
    if (!view) return;
    const next = views.map((v) =>
      v.id !== view.id
        ? v
        : { ...v, columns: v.columns.map((c) => (c.id === columnId ? { ...c, display: c.display === "expand" ? "truncate" as const : "expand" as const } : c)) },
    );
    void api.saveViews(next).then(
      () => {
        views = next;
        renderBody();
      },
      (e: Error) => {
        rowsError = e.message;
        renderChrome();
      },
    );
  },
  onNoteSaved: () => void loadRows(),
};

function remembered(): string | null {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    // storage unavailable
  }
}

function activeView(): View | null {
  return views.find((v) => v.id === activeId) ?? null;
}

function selectTab(id: string): void {
  activeId = id;
  remember(id);
  sort = null;
  rows = [];
  fetchedAt = null;
  rowsError = null;
  renderChrome();
  renderBody();
  void loadRows();
}

function renderChrome(): void {
  tabsEl.replaceChildren(
    ...views.map((v) =>
      h("button", { type: "button", class: `tab${v.id === activeId ? " active" : ""}`, onclick: () => selectTab(v.id) }, v.name),
    ),
  );
  const view = activeView();
  headerEl.replaceChildren();
  if (view) {
    const busy = refreshingIds.has(view.id);
    const refresh = h("button", { type: "button", class: "btn", onclick: () => void doRefresh() }, busy ? "Refreshing…" : "Refresh");
    if (busy) refresh.setAttribute("disabled", "");
    headerEl.append(
      h("code", { class: "jql" }, view.jql),
      h("span", { class: "text-muted last-refreshed" }, `Last refreshed ${relativeTime(fetchedAt)}`),
      refresh,
    );
  }
  const err = configError ?? rowsError;
  errorEl.textContent = err ?? "";
  errorEl.hidden = !err;
}

let renderDeferred = false;
onEditorsIdle(() => {
  if (renderDeferred) renderBody();
});

function renderBody(): void {
  // Never rebuild the table under an open editor; apply the latest state once it closes.
  if (isEditing()) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;
  const view = activeView();
  if (!view || !columns) {
    tableEl.replaceChildren(h("p", { class: "empty-state" }, configError ? "" : "No views configured."));
    return;
  }
  let shown = applyFilters(rows, view.filters);
  if (sort) shown = sortRows(shown, sort.columnId, sort.dir);
  renderTable(tableEl, view, shown, columns, handlers, sort);
}

async function loadConfig(): Promise<void> {
  try {
    const cfg = await api.config();
    views = cfg.views;
    columns = cfg.columns;
    configError = cfg.error;
  } catch (e) {
    configError = (e as Error).message;
  }
  if (!views.some((v) => v.id === activeId)) {
    const saved = remembered();
    activeId = views.find((v) => v.id === saved)?.id ?? views[0]?.id ?? null;
  }
  renderChrome();
  renderBody();
  await loadRows();
}

async function loadRows(): Promise<void> {
  const id = activeId;
  if (!id) return;
  const seq = ++rowsSeq;
  try {
    const r = await api.rows(id);
    if (id !== activeId || seq !== rowsSeq) return;
    applyRows(r.rows, r.fetchedAt, r.error);
  } catch (e) {
    if (id === activeId && seq === rowsSeq) {
      rowsError = (e as Error).message;
      renderChrome();
    }
  }
}

function applyRows(r: Row[], at: string | null, err: string | null): void {
  rows = r;
  fetchedAt = at;
  rowsError = err;
  renderChrome();
  renderBody();
}

async function doRefresh(): Promise<void> {
  const id = activeId;
  if (!id || refreshingIds.has(id)) return;
  refreshingIds.add(id);
  renderChrome();
  try {
    const r = await api.refresh(id);
    if (id === activeId) {
      rowsSeq++; // supersede any in-flight rows fetch
      applyRows(r.rows, r.fetchedAt, r.error);
    }
  } catch (e) {
    if (id === activeId) rowsError = (e as Error).message;
  } finally {
    refreshingIds.delete(id);
    renderChrome();
  }
}

function onLive(e: LiveEvent): void {
  switch (e.type) {
    case "rows":
      if (e.viewId === activeId) void loadRows();
      break;
    case "note":
    case "groom":
      void loadRows();
      break;
    case "views":
    case "columns":
      void loadConfig();
      break;
    case "orphans":
      break;
  }
}

setInterval(() => {
  const el = headerEl.querySelector(".last-refreshed");
  if (el) el.textContent = `Last refreshed ${relativeTime(fetchedAt)}`;
}, 30_000); // keep "last refreshed" fresh
connectLive(onLive);
void loadConfig();
