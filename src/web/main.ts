import type { ColumnsConfig, Filters, LiveEvent, Row, View } from "../shared/types.ts";
import { applyFilters, sortRows } from "../shared/rowOps.ts";
import { api, type Orphan } from "./api.ts";
import { h, relativeTime } from "./dom.ts";
import { configureDrawer, drawerOnLive, openDrawer } from "./drawer.ts";
import { isEditing, onEditorsIdle } from "./editors.ts";
import { renderFilterBar } from "./filterBar.ts";
import { connectLive } from "./live.ts";
import { renderTable, type SortState, type TableHandlers } from "./table.ts";
import { openViewEditor, uniqueViewId } from "./viewEditor.ts";

const TAB_KEY = "atlassian-notes.activeTab";

let views: View[] = [];
let columns: ColumnsConfig | null = null;
let configError: string | null = null;
let activeId: string | null = null;
let rows: Row[] = [];
let fetchedAt: string | null = null;
let rowsError: string | null = null;
let saveError: string | null = null;
let rowsLoaded = false;
const refreshingIds = new Set<string>();
let rowsSeq = 0;
let sort: SortState | null = null;

const root = document.body;
const tabsEl = h("nav", { class: "tabs" });
const headerEl = h("div", { class: "view-header" });
const errorEl = h("div", { class: "error-bar", role: "alert" });
const filterEl = h("div", { class: "filter-bar" });
const orphansEl = h("div", { class: "orphans-panel" });
orphansEl.hidden = true;
const tableEl = h("div", { class: "table-wrap" });
root.append(h("main", { class: "app" }, tabsEl, headerEl, orphansEl, errorEl, filterEl, tableEl));
configureDrawer({
  getRow: (key) => rows.find((r) => r.ticket.key === key),
  onNoteSaved: () => void loadRows(),
});
let orphans: Orphan[] = [];
let orphansOpen = false;

const handlers: TableHandlers = {
  onOpen(key) {
    openDrawer(key);
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
        saveError = null;
        renderChrome();
        renderBody();
      },
      (e: Error) => {
        saveError = e.message;
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

function onFiltersChanged(filters: Filters): void {
  const view = activeView();
  if (!view) return;
  const previous = views;
  const next = views.map((v) => (v.id === view.id ? { ...v, filters } : v));
  views = next; // optimistic: the chips and counts update at once
  renderBody();
  api.saveViews(next).then(
    () => {
      saveError = null;
      renderChrome();
    },
    (e: Error) => {
      if (views === next) views = previous;
      saveError = e.message;
      renderChrome();
      renderBody();
    },
  );
}

async function saveEditedView(edited: View, isNew: boolean): Promise<void> {
  const id = isNew ? uniqueViewId(edited.name, views.map((v) => v.id)) : edited.id;
  const saved = { ...edited, id };
  const old = views.find((v) => v.id === id);
  if (!isNew) {
    if (!old) throw new Error("This view no longer exists (it was changed on disk). Close the dialog and reopen it.");
    saved.filters = old.filters; // keep filters changed since the dialog opened
  }
  const next = isNew ? [...views, saved] : views.map((v) => (v.id === id ? saved : v));
  await api.saveViews(next);
  views = next;
  const needsRefresh = isNew || old?.jql !== saved.jql || old?.limit !== saved.limit;
  if (isNew) selectTab(id);
  else {
    renderChrome();
    renderBody();
  }
  if (needsRefresh) void doRefresh();
}

async function deleteView(id: string): Promise<void> {
  const next = views.filter((v) => v.id !== id);
  await api.saveViews(next);
  views = next;
  if (activeId === id && next[0]) selectTab(next[0].id);
  else {
    renderChrome();
    renderBody();
  }
}

function editView(view: View | null): void {
  if (!columns) return;
  openViewEditor(
    view,
    columns,
    (v) => saveEditedView(v, view === null),
    view && views.length > 1 ? () => deleteView(view.id) : undefined,
  );
}

function selectTab(id: string): void {
  activeId = id;
  remember(id);
  sort = null;
  rows = [];
  fetchedAt = null;
  rowsError = null;
  rowsLoaded = false;
  renderChrome();
  renderBody();
  void loadRows();
}

function renderChrome(): void {
  tabsEl.replaceChildren(
    ...views.map((v) =>
      h("span", { class: `tab-wrap${v.id === activeId ? " active" : ""}` },
        h("button", { type: "button", class: `tab${v.id === activeId ? " active" : ""}`, onclick: () => selectTab(v.id) }, v.name),
        h("button", { type: "button", class: "tab-edit", title: "Edit view", "aria-label": `Edit view ${v.name}`, onclick: () => editView(v) }, "✎"),
      ),
    ),
    h("button", { type: "button", class: "tab tab-add", onclick: () => editView(null) }, "+ view"),
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
  if (orphans.length > 0) {
    headerEl.append(h("button", {
      type: "button",
      class: "link-btn orphan-link",
      "aria-expanded": String(orphansOpen),
      onclick: () => {
        orphansOpen = !orphansOpen;
        renderChrome();
      },
    }, `${orphans.length} orphaned ${orphans.length === 1 ? "note" : "notes"}`));
  }
  orphansEl.hidden = !(orphansOpen && orphans.length > 0);
  orphansEl.replaceChildren(
    h("div", { class: "text-muted" }, "Notes whose ticket is no longer found in Jira. The files are left untouched."),
    ...orphans.map((o) => h("div", { class: "orphan-row" }, h("code", { class: "key" }, o.key), h("code", { class: "text-muted" }, o.notePath), h("code", { class: "text-muted" }, o.groomPath))),
  );
  const err = [configError ?? rowsError, saveError].filter(Boolean).join("\n");
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
    filterEl.replaceChildren();
    tableEl.replaceChildren(h("p", { class: "empty-state" }, configError ? "" : "No views configured."));
    return;
  }
  let shown = applyFilters(rows, view.filters);
  renderFilterBar(filterEl, view, columns, { shown: shown.length, total: rows.length, loaded: rowsLoaded }, onFiltersChanged);
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

async function loadOrphans(): Promise<void> {
  try {
    orphans = await api.orphans();
  } catch {
    orphans = [];
  }
  if (orphans.length === 0) orphansOpen = false;
  renderChrome();
}

function applyRows(r: Row[], at: string | null, err: string | null): void {
  rows = r;
  rowsLoaded = true;
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
      drawerOnLive(e.key);
      break;
    case "views":
    case "columns":
      void loadConfig();
      break;
    case "orphans":
      void loadOrphans();
      break;
  }
}

setInterval(() => {
  const el = headerEl.querySelector(".last-refreshed");
  if (el) el.textContent = `Last refreshed ${relativeTime(fetchedAt)}`;
}, 30_000); // keep "last refreshed" fresh
connectLive(onLive);
void loadConfig();
void loadOrphans();
