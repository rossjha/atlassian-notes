import type { BoardOp, BoardResponse, ColumnsConfig, Filters, LiveEvent, ReadingConfig, ReadingItem, Row, View } from "../shared/types.ts";
import { icon, linkIcon, refreshButton } from "./icons.ts";
import { confirmDialog, themePickerButton, viewSettingsButton } from "./viewMenu.ts";
import { applyFilters, sortRows } from "../shared/rowOps.ts";
import { api, type Orphan } from "./api.ts";
import { applyOpLocal, shouldAutoMove } from "../shared/boardOps.ts";
import { isDragging, onDragIdle, renderBoard, type BoardHandlers } from "./board.ts";
import { h, relativeTime } from "./dom.ts";
import { configureDrawer, drawerOnLive, drawerSyncStar, openDrawer, closeDrawer, currentDrawerKey, toast } from "./drawer.ts";
import { isEditing, onEditorsIdle } from "./editors.ts";
import { renderAnalysis } from "./analysis.ts";
import { renderFilterBar } from "./filterBar.ts";
import { connectLive } from "./live.ts";
import { renderTable, type SortState, type TableHandlers } from "./table.ts";
import { isColumnDragging, onColumnDragIdle } from "./columnDrag.ts";
import { moveColumn, setColumnWidth } from "../shared/columnOps.ts";
import { moveById } from "../shared/order.ts";
import { jiraSearchUrl } from "../shared/jiraUrls.ts";
import { chartsFor, drillRows, parseAnalysisConfig, type AnalysisConfig, type Drill } from "../shared/analysis.ts";
import { keywordClause, splitOrderBy, ticketKeyFromInput, withKeyword } from "../shared/search.ts";
import type { NavLink } from "../shared/links.ts";
import { attachTabDrag, isTabDragging } from "./tabDrag.ts";
import { flushScratchpad, showScratchpad } from "./scratchpad.ts";
import { openViewEditor, uniqueViewId } from "./viewEditor.ts";
import { applySavedTheme, currentTheme, saveTheme, THEMES } from "./themes.ts";
import { tabNavDir, withPageTransition } from "./motion.ts";
import { initPalette } from "./palette.ts";
import { clearReadingUrl, focusReadingUrl, renderReading, type ReadingTabState } from "./reading.ts";
import { configureReadingDrawer, openReadingDrawer, readingDrawerOnLive, readingDrawerSyncStar } from "./readingDrawer.ts";
import { normaliseUrl, readingIdFromCard, type ReadingSortKey } from "../shared/reading.ts";
import type { PaletteCommand } from "../shared/palette.ts";

// Fallback: public/theme-init.js (a blocking script in <head>) normally applies the saved theme before first paint.
applySavedTheme();

const TAB_KEY = "atlassian-notes.activeTab";
/** Special tab id; never a view id (view ids can't contain "_"). */
const BOARD_TAB = "__board";
const SCRATCH_TAB = "__scratch";
const READING_TAB = "__reading";
/** Kanban, Scratchpad and Reading: tabs that aren't Jira views. */
const isFixedTab = (id: string | null): boolean => id === BOARD_TAB || id === SCRATCH_TAB || id === READING_TAB;
const READING_STATUS_KEY = "atlassian-notes.readingStatus";

let views: View[] = [];
let columns: ColumnsConfig | null = null;
let jiraBaseUrl: string | null = null;
let defaultProject: string | null = null;
let navLinks: NavLink[] = [];
let linksError: string | null = null;
let configError: string | null = null;
let activeId: string | null = null;
let rows: Row[] = [];
let fetchedAt: string | null = null;
let rowsError: string | null = null;
let saveError: string | null = null;
let rowsLoaded = false;
// Tickets | Analysis per view (remembered in this browser), the analysis config, and the Analysis drill-down.
const VIEW_MODE_KEY = "atlassian-notes.viewMode.";
let analysisCfg: AnalysisConfig | null = null;
let analysisError: string | null = null;
const EMPTY_ANALYSIS = parseAnalysisConfig(null);
/** Tickets narrowed from a chart click; temporary, cleared by ×, leaving the view or going back to Analysis. */
let drill: { viewId: string; d: Drill } | null = null;
/** The view whose Analysis entrance has played since it was last shown; it plays again only after a switch. */
let analysisPlayedFor: string | null = null;

function viewMode(id: string): "tickets" | "analysis" {
  try {
    return localStorage.getItem(VIEW_MODE_KEY + id) === "analysis" ? "analysis" : "tickets";
  } catch {
    return "tickets";
  }
}

function setViewMode(id: string, mode: "tickets" | "analysis"): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY + id, mode);
  } catch {
    // storage unavailable: the mode just isn't remembered
  }
  if (mode === "analysis") {
    if (drill?.viewId === id) drill = null;
    analysisPlayedFor = null;
  }
  renderChrome();
  renderBody();
}

function onAnalysisDrill(d: Drill): void {
  const view = activeView();
  if (!view) return;
  drill = { viewId: view.id, d };
  setViewMode(view.id, "tickets");
}

// Keyword search beside the JQL bar: one input kept across renderChrome() so typing and focus survive re-renders.
const keywordInput = h("input", {
  type: "text",
  class: "keyword-input",
  placeholder: "Search this view…",
  title: "Adds AND text ~ \"…\" to this tab's query (Enter searches, Esc or × clears)",
  "aria-label": "Search this view by keyword",
  autocomplete: "off",
  spellcheck: "false",
}) as HTMLInputElement;
const keywordClear = h("button", { type: "button", class: "keyword-clear", title: "Clear the search", "aria-label": "Clear the search" }, icon("xMark", "keyword-clear-svg"));
const keywordField = h("form", { class: "keyword-field", role: "search" }, icon("magnifyingGlass", "keyword-icon"), keywordInput, keywordClear);
let keywordViewId: string | null = null;
const syncKeywordClear = (): void => {
  keywordClear.hidden = keywordInput.value === "";
};
keywordInput.addEventListener("input", syncKeywordClear);
keywordField.addEventListener("submit", (e) => {
  e.preventDefault();
  void commitKeyword(keywordInput.value);
});
keywordInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  keywordInput.value = "";
  syncKeywordClear();
  void commitKeyword("");
});
keywordClear.addEventListener("click", () => {
  keywordInput.value = "";
  syncKeywordClear();
  keywordInput.focus();
  void commitKeyword("");
});

/** Saves the active view's keyword search to views.yaml (blank removes it) and refreshes the view with it. */
async function commitKeyword(value: string): Promise<void> {
  const view = activeView();
  if (!view || viewsLocked()) return;
  const search = value.trim();
  if (search === (view.search ?? "")) return;
  const id = view.id;
  const apply = (v: View): View => {
    const { search: _old, ...rest } = v;
    return search ? { ...rest, search } : rest;
  };
  try {
    await saveViewsInOrder((vs) => vs.map((v) => (v.id === id ? apply(v) : v)));
    saveError = null;
  } catch (e) {
    saveError = (e as Error).message;
    renderChrome();
    return;
  }
  renderChrome();
  if (activeId === id) void doRefresh();
}

// Inline JQL editor in the view header; kept across renderChrome() so typing survives re-renders.
let jqlEditor: { viewId: string; el: HTMLTextAreaElement } | null = null;
let boardKeys = new Set<string>();
let boardData: BoardResponse | null = null;
let boardError: string | null = null; // board load/refresh failures; cleared when a board is applied
let boardRefreshing = false;
let boardReady = false; // true once GET /api/board has succeeded
let boardLocked = false; // board.yaml is broken (server-reported)
let boardSeq = 0; // bumped when a load starts
let opSeq = 0; // bumped when a star toggle or board op starts
let pendingOps = 0;
let opError = false; // saveError was set by a star/board op
const refreshingIds = new Set<string>();
let rowsSeq = 0;
let sort: SortState | null = null;
// Reading tab
let readingItems: ReadingItem[] = [];
let readingConfig: ReadingConfig = { statuses: ["Pending"], doneStatus: "Pending", categories: [], prompts: [], groomPrompt: "" };
let readingConfigError: string | null = null;
let readingError: string | null = null;
let readingLoaded = false;
let readingSeq = 0;
let readingFilter: { category: string | null; ticket: string | null } = { category: null, ticket: null };
let readingSort: { by: ReadingSortKey; dir: "asc" | "desc" } = { by: "created", dir: "desc" };
let readingNewId: string | null = null;
let readingHint: string | null = null;
let readingAdding = false;
/** undefined = not chosen yet (the first status); null = All. Remembered in this browser. */
let readingStatus: string | null | undefined = (() => {
  try {
    const v = localStorage.getItem(READING_STATUS_KEY);
    return v === null ? undefined : v === "" ? null : v;
  } catch {
    return undefined;
  }
})();

const root = document.body;
const tabsListEl = h("div", { class: "tabs-list" });
const searchHint = h("span", { class: "ticket-search-hint", role: "alert" });
searchHint.hidden = true;
const searchInput = h("input", {
  type: "text",
  class: "ticket-search-input",
  placeholder: "Key, number or link…",
  title: "Open a ticket by key, number or Jira link (⌘S). ⌘K for all commands",
  "aria-label": "Open ticket by key, number or Jira link",
  autocomplete: "off",
  spellcheck: "false",
}) as HTMLInputElement;
// ⌘S / Ctrl+S jumps to the ticket search (instead of the browser's "Save page").
// Not while a modal dialog is open; focusing search blurs an open note editor, which saves it as usual.
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "s" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
  e.preventDefault();
  if (currentDrawerKey()) closeDrawer(); // the search box sits behind the side panel
  searchInput.focus();
  searchInput.select();
});
const searchForm = h("form", { class: "ticket-search" }, h("label", { class: "ticket-search-field" }, icon("magnifyingGlass", "ticket-search-icon"), searchInput), searchHint);
searchInput.addEventListener("input", () => {
  searchHint.hidden = true;
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  searchInput.value = "";
  searchHint.hidden = true;
});
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (searchInput.value.trim() === "") return;
  const key = ticketKeyFromInput(searchInput.value, defaultProject);
  if (key === null) {
    searchHint.textContent = "Try ABC-123, 123 or a Jira link";
    searchHint.hidden = false;
    return;
  }
  searchInput.value = "";
  searchHint.hidden = true;
  openDrawer(key, { fromSearch: true });
});
const tabIndicatorEl = h("span", { class: "tab-indicator", "aria-hidden": "true" });
tabIndicatorEl.hidden = true;
/** links.yaml links: right of the ticket search, before the theme button, after a divider. */
const navLinksEl = h("div", { class: "nav-links" });
navLinksEl.hidden = true;
const tabsEl = h("nav", { class: "tabs" }, tabsListEl, searchForm, navLinksEl, themePickerButton(), tabIndicatorEl);
const rowsCache = new Map<string, { rows: Row[]; fetchedAt: string | null; error: string | null }>();
const headerEl = h("div", { class: "view-header" });
const errorEl = h("div", { class: "error-bar", role: "alert" });
errorEl.hidden = true; // shown by renderChrome only when there is an error; avoids an empty red bar on load
const filterEl = h("div", { class: "filter-bar" });
const orphansEl = h("div", { class: "orphans-panel" });
orphansEl.hidden = true;
const tableEl = h("div", { class: "table-wrap" });
// Kept (hidden) across tab switches: Excalidraw mounts once, so the canvas and its undo history survive.
const scratchEl = h("div", { class: "scratch" });
scratchEl.hidden = true;
root.append(h("main", { class: "app" }, tabsEl, headerEl, orphansEl, errorEl, filterEl, tableEl, scratchEl));
configureDrawer({
  getRow: (key) => rows.find((r) => r.ticket.key === key) ?? boardRow(key),
  onNoteSaved: () => void loadRows(),
  star: {
    isStarred: (k) => boardKeys.has(k),
    toggle: toggleStar,
    get disabled() {
      return !boardReady || boardLocked;
    },
    get locked() {
      return boardReady && boardLocked;
    },
  },
  onNoteSavedInDrawer: noteImpliesDoing,
  openReading: (id) => openReadingDrawer(id),
});
configureReadingDrawer({
  getItem: (id) => readingItems.find((i) => i.id === id),
  config: () => readingConfig,
  lockedReason: () => readingConfigError,
  star: {
    isStarred: (k) => boardKeys.has(k),
    toggle: toggleStar,
    get disabled() {
      return !boardReady || boardLocked;
    },
    get locked() {
      return boardReady && boardLocked;
    },
  },
  onChanged: () => {
    void loadReading();
    if (activeId === BOARD_TAB) void loadBoard();
  },
  openTicket: (key) => openDrawer(key),
});
function boardRow(key: string): Row | undefined {
  if (!boardData) return undefined;
  for (const cards of Object.values(boardData.cards)) {
    const card = cards.find((c) => c.key === key);
    if (card?.row) return card.row;
  }
  return undefined;
}
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
    updateActiveView((v) => ({
      ...v,
      columns: v.columns.map((c) => (c.id === columnId ? { ...c, display: c.display === "expand" ? "truncate" as const : "expand" as const } : c)),
    }));
  },
  onResizeColumn(columnId, width) {
    updateActiveColumns((cs) => setColumnWidth(cs, columnId, width));
  },
  onMoveColumn(columnId, toVisibleIndex) {
    updateActiveColumns((cs) => moveColumn(cs, columnId, toVisibleIndex));
  },
  onNoteSaved: () => void loadRows(),
};

function updateActiveColumns(change: (cs: View["columns"]) => View["columns"]): void {
  updateActiveView((v) => {
    const cols = change(v.columns);
    return cols === v.columns ? v : { ...v, columns: cols };
  });
}

// All PUT /api/views calls go through one chain so they reach the server in order, each sending the
// latest `views` at send time. While any are pending, loadConfig keeps the local (newer) views.
let viewsSaveChain: Promise<void> = Promise.resolve();
let pendingViewSaves = 0;
let reloadAfterSaves = false;

/**
 * Queues a save of views.yaml. Without `change`, saves the current (already optimistically updated) views;
 * if that fails, the views are reloaded from the server once the queue drains. With `change`, saves
 * change(views) and applies it locally only on success.
 */
function saveViewsInOrder(change?: (vs: View[]) => View[]): Promise<void> {
  pendingViewSaves++;
  const run = viewsSaveChain.then(async () => {
    try {
      await api.saveViews(change ? change(views) : views);
      if (change) views = change(views);
    } catch (e) {
      if (!change) reloadAfterSaves = true;
      throw e;
    } finally {
      pendingViewSaves--;
      if (pendingViewSaves === 0 && reloadAfterSaves) {
        reloadAfterSaves = false;
        void loadConfig(); // revert optimistic changes the server didn't take
      }
    }
  });
  viewsSaveChain = run.catch(() => {});
  return run;
}

/** Optimistically changes the active view (from the CURRENT views) and queues a save; saveError on failure. */
function updateActiveView(change: (v: View) => View): void {
  const view = activeView();
  if (!view || viewsLocked()) return;
  const changed = change(view);
  if (changed === view) return;
  views = views.map((v) => (v.id === view.id ? changed : v));
  renderBody();
  saveViewsInOrder().then(
    () => {
      saveError = null;
      renderChrome();
    },
    (e: Error) => {
      saveError = e.message;
      renderChrome();
    },
  );
}

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

/** While a config file is broken, nothing may save views (the server would refuse with 409 anyway). */
function viewsLocked(): boolean {
  return configError !== null;
}

function activeView(): View | null {
  return views.find((v) => v.id === activeId) ?? null;
}

function onFiltersChanged(filters: Filters): void {
  updateActiveView((v) => ({ ...v, filters })); // optimistic: the chips and counts update at once
}

async function saveEditedView(edited: View, isNew: boolean): Promise<void> {
  const id = isNew ? uniqueViewId(edited.name, views.map((v) => v.id)) : edited.id;
  const saved = { ...edited, id };
  const old = views.find((v) => v.id === id);
  if (!isNew) {
    if (!old) throw new Error("This view no longer exists (it was changed on disk). Close the dialog and reopen it.");
    saved.filters = old.filters; // keep filters changed since the dialog opened
  }
  // Keep filters changed meanwhile, and the keyword search (the dialog doesn't edit it).
  const keep = (v: View): View => (v.search ? { ...saved, filters: v.filters, search: v.search } : { ...saved, filters: v.filters });
  await saveViewsInOrder((vs) => (isNew ? [...vs, saved] : vs.map((v) => (v.id === id ? keep(v) : v))));
  const needsRefresh = isNew || old?.jql !== saved.jql || old?.limit !== saved.limit;
  if (isNew) selectTab(id);
  else {
    renderChrome();
    renderBody();
  }
  if (needsRefresh) void doRefresh();
}

async function deleteView(id: string): Promise<void> {
  await saveViewsInOrder((vs) => vs.filter((v) => v.id !== id));
  if (activeId === id && views[0]) selectTab(views[0].id);
  else {
    renderChrome();
    renderBody();
  }
}

async function confirmDeleteView(view: View): Promise<void> {
  if (viewsLocked() || views.length <= 1) return;
  const ok = await confirmDialog({
    title: `Delete view "${view.name}"?`,
    body: "This removes the tab and its saved JQL, columns and filters from views.yaml. Your notes, Claude's groom files and your Kanban board are not affected.",
    confirmLabel: "Delete view",
  });
  if (!ok) return;
  try {
    await deleteView(view.id);
    saveError = null;
  } catch (e) {
    saveError = (e as Error).message;
  }
  renderChrome();
}

function editView(view: View | null): void {
  if (!columns || viewsLocked()) return;
  openViewEditor(
    view,
    columns,
    (v) => saveEditedView(v, view === null),
    undefined, // deleting lives in the tab's ⋯ menu, with its own confirmation
  );
}

function startJqlEdit(view: View): void {
  if (viewsLocked()) return;
  const el = h("textarea", { class: "jql jql-edit", rows: "1", spellcheck: "false", "aria-label": `JQL for ${view.name}` }) as HTMLTextAreaElement;
  el.value = view.jql;
  const fit = () => {
    el.style.setProperty("height", "auto");
    // scrollHeight excludes the border, but box-sizing is border-box, so add it back or the text shifts.
    el.style.setProperty("height", `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`);
  };
  el.addEventListener("input", fit);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelJqlEdit();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commitJqlEdit();
    }
  });
  jqlEditor = { viewId: view.id, el };
  renderChrome();
  fit();
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

function cancelJqlEdit(): void {
  jqlEditor = null;
  renderChrome();
}

async function commitJqlEdit(): Promise<void> {
  if (!jqlEditor) return;
  const { viewId, el } = jqlEditor;
  const view = views.find((v) => v.id === viewId);
  const jql = el.value.trim();
  if (!view || jql === view.jql) return cancelJqlEdit();
  if (jql === "") {
    saveError = "JQL can't be empty.";
    return renderChrome();
  }
  el.disabled = true;
  try {
    await saveEditedView({ ...view, jql }, false); // saves views.yaml and refreshes the view
    saveError = null;
    jqlEditor = null;
  } catch (e) {
    saveError = (e as Error).message;
    el.disabled = false;
  }
  renderChrome();
  if (jqlEditor) el.focus();
}

/** Position along the tab bar: Kanban is 0, Scratchpad 1, Reading 2, then the views in order; -1 if unknown. */
function tabIndex(id: string | null): number {
  if (id === BOARD_TAB) return 0;
  if (id === SCRATCH_TAB) return 1;
  if (id === READING_TAB) return 2;
  const i = views.findIndex((v) => v.id === id);
  return i < 0 ? -1 : i + 3;
}

function selectTab(id: string): void {
  // Measured before views/activeId move on. Null (no slide) for a re-selected tab, the first selection, or a deleted tab.
  const dir = tabNavDir(tabIndex(activeId), tabIndex(id));
  if (jqlEditor && jqlEditor.viewId !== id) jqlEditor = null;
  if (activeId === SCRATCH_TAB && id !== SCRATCH_TAB) void flushScratchpad();
  if (drill && drill.viewId !== id) drill = null; // a drill-down belongs to the view it came from
  if (id !== activeId) analysisPlayedFor = null; // arriving on a view's Analysis plays its entrance
  activeId = id;
  remember(id);
  // State changes above and below stay synchronous (callers such as saveEditedView read activeId straight after);
  // only the re-render runs inside the view transition, which may call it a frame later.
  const paint = () => {
    renderChrome();
    renderBody();
  };
  if (id === BOARD_TAB) {
    rowsSeq++; // supersede any in-flight rows fetch
    withPageTransition(dir, paint, [headerEl, filterEl, tableEl, scratchEl]);
    void loadBoard();
    return;
  }
  if (id === SCRATCH_TAB) {
    rowsSeq++;
    withPageTransition(dir, paint, [headerEl, filterEl, tableEl, scratchEl]);
    return;
  }
  if (id === READING_TAB) {
    rowsSeq++;
    withPageTransition(dir, paint, [headerEl, filterEl, tableEl, scratchEl]);
    void loadReading();
    return;
  }
  sort = null;
  // Show this view's last rows straight away (refreshed below), so the slide carries real content, not "No tickets".
  const cached = rowsCache.get(id);
  rows = cached?.rows ?? [];
  fetchedAt = cached?.fetchedAt ?? null;
  rowsError = cached?.error ?? null;
  rowsLoaded = cached !== undefined;
  withPageTransition(dir, paint, [headerEl, filterEl, tableEl, scratchEl]);
  void loadRows();
}

/** Places the single active-tab underline under the active tab. It lives on the nav (not inside a tab), so it
 * survives re-renders and its CSS left/width transition glides it between tabs. */
function placeTabIndicator(): void {
  const active = tabsListEl.querySelector<HTMLElement>(".tab-wrap.active");
  if (!active) {
    tabIndicatorEl.hidden = true;
    return;
  }
  const nav = tabsEl.getBoundingClientRect();
  const r = active.getBoundingClientRect();
  tabIndicatorEl.hidden = false;
  tabIndicatorEl.style.setProperty("left", `${r.left - nav.left - tabsEl.clientLeft}px`);
  tabIndicatorEl.style.setProperty("width", `${r.width}px`);
  tabIndicatorEl.style.setProperty("top", `${r.bottom - nav.top - tabsEl.clientTop - 2}px`);
  if (!tabIndicatorEl.classList.contains("tab-indicator-ready")) requestAnimationFrame(() => tabIndicatorEl.classList.add("tab-indicator-ready"));
}
void document.fonts?.ready.then(() => placeTabIndicator()); // tab widths change once JetBrains Mono loads
window.addEventListener("resize", () => {
  tabIndicatorEl.classList.remove("tab-indicator-ready"); // no glide while resizing
  placeTabIndicator();
});

/** Set while a tab drag holds back a tab bar rebuild; the drag's end applies it. */
let tabsPending = false;

function renderTabs(): void {
  if (isTabDragging()) {
    tabsPending = true;
    return;
  }
  tabsPending = false;
  // A rebuild keeps focus on the same view tab (so Alt+Shift+←/→ can be pressed repeatedly).
  const focusedId = (document.activeElement?.closest(".tab-wrap") as HTMLElement | null)?.dataset.viewId ?? null;
  const locked = viewsLocked();
  const onBoard = activeId === BOARD_TAB;
  const onScratch = activeId === SCRATCH_TAB;
  const onReading = activeId === READING_TAB;
  const viewTabs = views.map((v) =>
    h("span", { class: `tab-wrap${v.id === activeId ? " active" : ""}`, "data-view-id": v.id },
      h("button", {
        type: "button",
        class: `tab${v.id === activeId ? " active" : ""}`,
        ...(locked ? {} : { title: "Drag to reorder (or Alt+Shift+←/→)" }),
        onclick: () => selectTab(v.id),
      }, v.name),
    ),
  );
  tabsListEl.replaceChildren(
    h("span", { class: `tab-wrap${onBoard ? " active" : ""}` },
      h("button", { type: "button", class: `tab tab-kanban${onBoard ? " active" : ""}`, title: "Kanban", "aria-label": "Kanban", onclick: () => selectTab(BOARD_TAB) }, icon("viewColumns", "tab-svg")),
    ),
    h("span", { class: `tab-wrap${onScratch ? " active" : ""}` },
      h("button", { type: "button", class: `tab tab-kanban${onScratch ? " active" : ""}`, title: "Scratchpad", "aria-label": "Scratchpad", onclick: () => selectTab(SCRATCH_TAB) }, icon("paintBrush", "tab-svg")),
    ),
    h("span", { class: `tab-wrap${onReading ? " active" : ""}` },
      h("button", { type: "button", class: `tab tab-kanban${onReading ? " active" : ""}`, title: "Reading list", "aria-label": "Reading list", onclick: () => selectTab(READING_TAB) }, icon("eyeglasses", "tab-svg")),
    ),
    h("span", { class: "tabs-divider", "aria-hidden": "true" }, "|"),
    ...viewTabs,
  );
  navLinksEl.replaceChildren(...(navLinks.length ? [h("span", { class: "tabs-divider", "aria-hidden": "true" }, "|"), ...navLinks.map(navLinkTab)] : []));
  navLinksEl.hidden = navLinks.length === 0;
  if (!locked) {
    tabsListEl.append(h("button", { type: "button", class: "icon-btn tab-add", title: "Add view", "aria-label": "Add view", onclick: () => editView(null) }, icon("plusCircle", "icon-btn-svg")));
    attachTabDrag(viewTabs, views.map((v) => v.id), moveViewTab, () => {
      if (tabsPending) renderTabs();
    });
  }
  if (focusedId !== null) viewTabs[views.findIndex((v) => v.id === focusedId)]?.querySelector<HTMLElement>(".tab")?.focus();
  placeTabIndicator();
}

/** A links.yaml link in the top bar's right-hand group: its icon, or its name when it has none. */
function navLinkTab(l: NavLink): HTMLElement {
  const label = l.newTab ? `${l.name} (opens in a new tab)` : l.name;
  const body = l.icon === null
    ? l.name
    : l.icon.kind === "named"
      ? linkIcon(l.icon.name, "tab-svg")
      : h("span", { class: "tab-emoji", "aria-hidden": "true" }, l.icon.text);
  const a = h("a", { class: `tab tab-kanban tab-link${l.icon === null ? " tab-link-text" : ""}`, href: l.url, title: label, "aria-label": label }, body);
  if (l.newTab) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  } else {
    a.addEventListener("click", () => void flushScratchpad()); // leaving the page: save the drawing first
  }
  return h("span", { class: "tab-wrap" }, a);
}

/** Optimistically moves a view tab and saves the new order to views.yaml. */
function moveViewTab(id: string, to: number): void {
  const next = moveById(views, id, to);
  if (next === views || viewsLocked()) return renderTabs();
  views = next;
  renderTabs();
  saveViewsInOrder().then(
    () => {
      saveError = null;
      renderChrome();
    },
    (e: Error) => {
      saveError = e.message;
      renderChrome();
    },
  );
}

function renderChrome(): void {
  const locked = viewsLocked();
  const jqlHadFocus = jqlEditor !== null && document.activeElement === jqlEditor.el;
  const onBoard = activeId === BOARD_TAB;
  const onScratch = activeId === SCRATCH_TAB;
  const onReading = activeId === READING_TAB;
  renderTabs();
  const view = activeView();
  headerEl.replaceChildren();
  if (view) {
    const busy = refreshingIds.has(view.id);
    const refresh = refreshButton(busy, false, () => void doRefresh());
    if (jqlEditor && (locked || jqlEditor.viewId !== view.id)) jqlEditor = null;
    const jql = jqlEditor
      ? jqlEditor.el
      : locked
        ? h("code", { class: "jql" }, view.jql)
        : h("button", { type: "button", class: "jql jql-btn", title: "Click to edit JQL (Enter saves, Esc cancels)", onclick: () => startJqlEdit(view) }, view.jql);
    if (view.search && !jqlEditor) {
      // Show the keyword clause where it's sent: after the filter, before any ORDER BY.
      const { where, orderBy } = splitOrderBy(view.jql);
      jql.replaceChildren(where, h("span", { class: "jql-keyword" }, `${where ? " AND " : ""}${keywordClause(view.search)}`), orderBy ? ` ${orderBy}` : "");
    }
    // Show the view's saved keyword unless the person is typing in the box for this same view.
    if (keywordViewId !== view.id || document.activeElement !== keywordInput) keywordInput.value = view.search ?? "";
    keywordViewId = view.id;
    keywordInput.disabled = locked;
    syncKeywordClear();
    const mode = viewMode(view.id);
    const modeBtn = (m: "tickets" | "analysis", label: string) =>
      h("button", { type: "button", "aria-pressed": String(mode === m), onclick: () => { if (mode !== m) setViewMode(view.id, m); } }, label);
    headerEl.append(
      h("div", { class: "view-mode", role: "group", "aria-label": "Show tickets or analysis" }, modeBtn("tickets", "Tickets"), modeBtn("analysis", "Analysis")),
      h("div", { class: "jql-field" },
        icon("jira", "jql-icon brand-jira"),
        jql,
        jiraBaseUrl && !jqlEditor
          ? h("a", {
              class: "jql-open",
              href: jiraSearchUrl(jiraBaseUrl, withKeyword(view.jql, view.search)),
              target: "_blank",
              rel: "noopener noreferrer",
              title: "Open this query in Jira",
              "aria-label": "Open this query in Jira",
            }, icon("arrowTopRightOnSquare", "jql-open-svg"))
          : null,
      ),
      keywordField,
      h("span", { class: "text-muted last-refreshed" }, `Last refreshed ${relativeTime(fetchedAt)}`),
      refresh,
    );
    if (!locked) {
      headerEl.append(viewSettingsButton(view.name, {
        onEdit: () => editView(view),
        onDelete: () => void confirmDeleteView(view),
        deleteDisabledReason: views.length <= 1 ? "You need at least one view" : undefined,
      }));
    }
    if (jqlHadFocus && jqlEditor) jqlEditor.el.focus();
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
  headerEl.hidden = (onBoard || onScratch || onReading) && orphans.length === 0; // the board draws its own header; the scratchpad has none
  orphansEl.hidden = !(orphansOpen && orphans.length > 0);
  orphansEl.replaceChildren(
    h("div", { class: "text-muted" }, "Notes whose ticket is no longer found in Jira. The files are left untouched."),
    ...orphans.map((o) => h("div", { class: "orphan-row" }, h("code", { class: "key" }, o.key), h("code", { class: "text-muted" }, o.notePath), h("code", { class: "text-muted" }, o.groomPath))),
  );
  const err = [
    ...(onBoard ? [boardData?.error, boardError, opError ? saveError : null]
      : onScratch ? []
      : onReading ? [readingConfigError, readingError, opError ? saveError : null]
      : [configError ?? rowsError, saveError, analysisError ? `${analysisError} — Analysis is showing the default charts` : null]),
    linksError,
  ].filter(Boolean).join("\n");
  errorEl.textContent = err;
  errorEl.hidden = !err;
}

let renderDeferred = false;
onEditorsIdle(() => {
  if (renderDeferred) renderBody();
});
onDragIdle(() => {
  if (renderDeferred) renderBody();
});
onColumnDragIdle(() => {
  if (renderDeferred) renderBody();
});

function applyBoard(b: BoardResponse): void {
  boardData = b;
  boardError = null;
  boardKeys = new Set(Object.values(b.cards).flatMap((cs) => cs.map((c) => c.key)));
  boardLocked = b.locked;
  boardReady = true;
}

async function loadBoard(): Promise<void> {
  const seq = ++boardSeq;
  const ops = opSeq;
  // A result is stale if a newer load started, or a toggle started/is in flight (its own response resyncs).
  const stale = () => seq !== boardSeq || ops !== opSeq || pendingOps > 0;
  try {
    const b = await api.board();
    if (stale()) return;
    applyBoard(b);
  } catch (e) {
    if (stale()) return;
    boardReady = false; // errors surface on the board tab
    boardError = (e as Error).message;
  }
  renderChrome();
  renderBody();
}

/** Sends one board op; the caller has already applied its optimistic change. Only the latest op's response is applied. */
function submitBoardOp(op: BoardOp, revert?: () => void): void {
  const id = ++opSeq;
  pendingOps++;
  renderBody();
  api.boardOp(op).then(
    (b) => {
      pendingOps--;
      if (id !== opSeq) return; // a newer op's response carries the truth
      applyBoard(b); // server truth, including concurrent changes
      if (opError) {
        saveError = null;
        opError = false;
      }
      renderChrome();
      renderBody();
    },
    (e: Error) => {
      pendingOps--;
      revert?.();
      saveError = e.message;
      opError = true;
      renderChrome();
      renderBody();
      void loadBoard();
    },
  );
}

function toggleStar(key: string): void {
  if (!boardReady || boardLocked) return;
  const starred = boardKeys.has(key);
  boardKeys = new Set(boardKeys);
  if (starred) boardKeys.delete(key);
  else boardKeys.add(key);
  submitBoardOp({ op: starred ? "remove" : "add", key }, () => {
    boardKeys = new Set(boardKeys); // revert only this key
    if (starred) boardKeys.add(key);
    else boardKeys.delete(key);
  });
}

/** A note was saved from a search-opened drawer: a ticket that isn't on the board goes to the note column. */
function noteImpliesDoing(key: string, body: string, openedFromSearch: boolean): void {
  if (!boardData) return;
  const column = boardData.noteColumn;
  if (!shouldAutoMove({ openedFromSearch, onBoard: boardKeys.has(key), ready: boardReady, locked: boardLocked, body, noteColumn: column })) return;
  boardKeys = new Set(boardKeys).add(key);
  submitBoardOp({ op: "move", key, column, index: Number.MAX_SAFE_INTEGER }, () => {
    boardKeys = new Set(boardKeys);
    boardKeys.delete(key);
  });
}

function boardOp(op: BoardOp): void {
  if (!boardData || boardData.locked) return;
  boardData = applyOpLocal(boardData, op);
  boardKeys = new Set(Object.values(boardData.cards).flatMap((cs) => cs.map((c) => c.key)));
  submitBoardOp(op); // on failure loadBoard() restores the server's board
}

async function refreshBoard(): Promise<void> {
  if (boardRefreshing) return;
  boardRefreshing = true;
  const ops = opSeq;
  renderChrome();
  renderBody();
  try {
    const b = await api.refreshBoard();
    if (ops === opSeq && pendingOps === 0) {
      boardSeq++; // supersede any in-flight load
      applyBoard(b);
    }
  } catch (e) {
    boardError = (e as Error).message;
  } finally {
    boardRefreshing = false;
    renderChrome();
    renderBody();
  }
}

const boardHandlers: BoardHandlers = {
  onOpen: (key) => {
    const readingId = readingIdFromCard(key);
    if (readingId !== null) openReadingDrawer(readingId);
    else openDrawer(key);
  },
  onOp: boardOp,
  onNoteSaved: () => void loadBoard(),
  onRefresh: () => void refreshBoard(),
  refreshing: false,
  archiveCount: () => (boardData ? (boardData.cards[boardData.archiveColumn] ?? []).length : 0),
};

function renderBody(): void {
  drawerSyncStar(); // the drawer's ★ follows the board even while a table render is deferred
  readingDrawerSyncStar();
  // Never rebuild the table under an open editor; apply the latest state once it closes.
  if (isEditing() || isDragging() || isColumnDragging()) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;
  const onScratch = activeId === SCRATCH_TAB;
  scratchEl.hidden = !onScratch;
  tableEl.hidden = onScratch;
  if (onScratch) {
    filterEl.replaceChildren();
    filterEl.hidden = true;
    void showScratchpad(scratchEl);
    return;
  }
  if (activeId === READING_TAB) {
    filterEl.replaceChildren();
    filterEl.hidden = true;
    renderReadingTab();
    return;
  }
  if (activeId === BOARD_TAB) {
    filterEl.replaceChildren();
    filterEl.hidden = true;
    if (boardData) renderBoard(tableEl, boardData, { ...boardHandlers, refreshing: boardRefreshing });
    else {
      const refresh = refreshButton(boardRefreshing, false, () => void refreshBoard());
      tableEl.replaceChildren(
        h("div", { class: "view-header board-header" }, h("span", { class: "text-muted last-refreshed" }, "Last refreshed never"), refresh),
        h("p", { class: "empty-state" }, boardError ? "" : "Loading board…"),
      );
    }
    return;
  }
  filterEl.hidden = false;
  const view = activeView();
  if (!view || !columns) {
    filterEl.replaceChildren();
    tableEl.replaceChildren(h("p", { class: "empty-state" }, configError ? "" : "No views configured."));
    return;
  }
  const tableHandlers: TableHandlers = {
    ...handlers,
    star: { isStarred: (k) => boardKeys.has(k), toggle: toggleStar, disabled: !boardReady || boardLocked, locked: boardReady && boardLocked },
  };
  if (viewMode(view.id) === "analysis") {
    filterEl.replaceChildren();
    filterEl.hidden = true;
    if (!rowsLoaded) {
      tableEl.replaceChildren(h("p", { class: "empty-state" }, "Loading…"));
      return;
    }
    const animate = analysisPlayedFor !== view.id;
    analysisPlayedFor = view.id;
    renderAnalysis(tableEl, { rows, viewId: view.id, cfg: analysisCfg, columns, now: new Date(), animate }, {
      onDrill: onAnalysisDrill,
      onOpenTicket: (key) => openDrawer(key),
    });
    return;
  }
  if (drill && drill.viewId !== view.id) drill = null;
  const settings = chartsFor(analysisCfg, view.id, false).settings;
  const base = drill ? drillRows(rows, drill.d, analysisCfg ?? EMPTY_ANALYSIS, settings, new Date()) : rows;
  let shown = applyFilters(base, view.filters);
  const locked = viewsLocked();
  const drillChip = drill ? { label: drill.d.label, onClear: () => { drill = null; renderBody(); } } : undefined;
  if (locked) filterEl.replaceChildren();
  else renderFilterBar(filterEl, view, columns, { shown: shown.length, total: rows.length, loaded: rowsLoaded }, onFiltersChanged, drillChip);
  if (sort) shown = sortRows(shown, sort.columnId, sort.dir);
  renderTable(tableEl, view, shown, columns, locked ? { ...tableHandlers, onToggleDisplay: undefined, onResizeColumn: undefined, onMoveColumn: undefined } : tableHandlers, sort);
}

async function loadConfig(): Promise<void> {
  try {
    const cfg = await api.config();
    if (pendingViewSaves === 0) views = cfg.views; // else a queued save holds newer views; its own live event reloads
    columns = cfg.columns;
    jiraBaseUrl = cfg.jiraBaseUrl;
    analysisCfg = cfg.analysis ?? null;
    analysisError = cfg.analysisError ?? null;
    defaultProject = cfg.defaultProject ?? null;
    navLinks = cfg.links ?? [];
    linksError = cfg.linksError ?? null;
    configError = cfg.error;
  } catch (e) {
    configError = (e as Error).message;
  }
  if (!isFixedTab(activeId) && !views.some((v) => v.id === activeId)) {
    const saved = remembered();
    activeId = isFixedTab(saved) ? saved : views.find((v) => v.id === saved)?.id ?? views[0]?.id ?? null;
  }
  renderChrome();
  renderBody();
  if (activeId === BOARD_TAB) await loadBoard();
  else if (activeId === READING_TAB) await loadReading();
  else if (activeId !== SCRATCH_TAB) await loadRows();
}

async function loadRows(): Promise<void> {
  const id = activeId;
  if (!id || isFixedTab(id)) return;
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
  if (activeId && !isFixedTab(activeId)) rowsCache.set(activeId, { rows: r, fetchedAt: at, error: err });
  rows = r;
  rowsLoaded = true;
  fetchedAt = at;
  rowsError = err;
  renderChrome();
  renderBody();
}

async function doRefresh(): Promise<void> {
  const id = activeId;
  if (!id || isFixedTab(id) || refreshingIds.has(id)) return;
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
      if (activeId === BOARD_TAB) void loadBoard();
      drawerOnLive(e.key);
      break;
    case "views":
    case "columns":
    case "links":
    case "analysis":
      void loadConfig();
      break;
    case "board":
      void loadBoard();
      break;
    case "orphans":
      void loadOrphans();
      break;
    case "reading":
    case "readingGroom":
      readingDrawerOnLive(e.id);
      if (activeId === READING_TAB) void loadReading();
      if (activeId === BOARD_TAB) void loadBoard();
      break;
    case "readingConfig":
      void loadReading();
      if (activeId === BOARD_TAB) void loadBoard();
      break;
  }
}

function readingTabState(): ReadingTabState {
  const status = readingStatus === undefined ? readingConfig.statuses[0] ?? null : readingStatus;
  return {
    items: readingItems,
    config: readingConfig,
    loaded: readingLoaded,
    status,
    category: readingFilter.category,
    ticket: readingFilter.ticket,
    sort: readingSort,
    newId: readingNewId,
    hint: readingHint,
    adding: readingAdding,
  };
}

function setReadingStatus(status: string | null): void {
  readingStatus = status;
  try {
    localStorage.setItem(READING_STATUS_KEY, status ?? "");
  } catch {
    // storage unavailable
  }
  renderBody();
}

function renderReadingTab(): void {
  renderReading(tableEl, readingTabState(), {
    onAdd: (url) => void addReading(url),
    onOpen: (id) => openReading(id),
    onOpenTicket: (key) => openDrawer(key),
    onStatusTab: setReadingStatus,
    onFilter: (f) => {
      readingFilter = { ...readingFilter, ...f };
      renderBody();
    },
    onSort: (by) => {
      readingSort = readingSort.by === by ? { by, dir: readingSort.dir === "asc" ? "desc" : "asc" } : { by, dir: by === "title" || by === "status" || by === "category" || by === "tickets" ? "asc" : "desc" };
      renderBody();
    },
    onHintClear: () => {
      if (readingHint === null) return;
      readingHint = null;
      renderBody();
    },
    star: { isStarred: (k) => boardKeys.has(k), toggle: toggleStar, disabled: !boardReady || boardLocked, locked: boardReady && boardLocked },
  });
}

async function loadReading(): Promise<void> {
  const seq = ++readingSeq;
  try {
    const r = await api.readingList();
    if (seq !== readingSeq) return;
    readingItems = r.items;
    readingConfig = r.config;
    readingConfigError = r.error;
    readingError = null;
  } catch (e) {
    if (seq !== readingSeq) return;
    readingError = (e as Error).message;
  }
  readingLoaded = true;
  if (activeId === READING_TAB) {
    renderChrome();
    renderBody();
  }
}

function openReading(id: string): void {
  openReadingDrawer(id);
}

async function addReading(url: string): Promise<void> {
  if (readingAdding) return;
  readingAdding = true;
  readingHint = null;
  renderBody();
  try {
    const { item, existed } = await api.addReading(url);
    clearReadingUrl();
    if (existed) {
      toast("Already on your list");
      openReading(item.id);
    } else {
      readingNewId = item.id;
      // Show it where it landed: its status sub-tab, unless All is showing.
      if (readingStatus !== null && readingTabState().status !== item.status) setReadingStatus(item.status);
    }
    await loadReading();
  } catch (e) {
    readingHint = (e as Error).message;
  } finally {
    readingAdding = false;
    renderBody();
  }
}

/** Commands for the ⌘K palette, built from the current state each time it opens or its query changes. */
function paletteCommands(query: string): PaletteCommand[] {
  const cs: PaletteCommand[] = [];
  const url = normaliseUrl(query);
  if (url !== null) {
    cs.push({ id: "reading-add-url", label: `Add ${url} to reading list`, group: "Reading", run: () => {
      if (activeId !== READING_TAB) selectTab(READING_TAB);
      void addReading(url);
    } });
  }
  const key = ticketKeyFromInput(query, defaultProject);
  if (key !== null) cs.push({ id: "open-key", label: `Open ${key}`, group: "Ticket", run: () => openDrawer(key, { fromSearch: true }) });
  cs.push({
    id: "find-key",
    label: "Find ticket by key",
    group: "Ticket",
    keywords: ["search", "open"],
    hint: "⌘S",
    run: () => {
      if (currentDrawerKey()) closeDrawer();
      searchInput.focus();
    },
  });

  cs.push(
    { id: "go-kanban", label: "Kanban", group: "Go to", keywords: ["board", "tab"], current: activeId === BOARD_TAB, run: () => selectTab(BOARD_TAB) },
    { id: "go-scratch", label: "Scratchpad", group: "Go to", keywords: ["excalidraw", "draw", "tab"], current: activeId === SCRATCH_TAB, run: () => selectTab(SCRATCH_TAB) },
    { id: "go-reading", label: "Reading list", group: "Go to", keywords: ["reading", "links", "confluence", "tab"], current: activeId === READING_TAB, run: () => selectTab(READING_TAB) },
    ...views.map((v): PaletteCommand => ({ id: `go-${v.id}`, label: v.name, group: "Go to", keywords: ["view", "tab"], current: v.id === activeId, run: () => selectTab(v.id) })),
    ...navLinks.map((l, i): PaletteCommand => ({
      id: `link-${i}`,
      label: l.name,
      group: "Go to",
      keywords: ["link"],
      ...(l.newTab ? { hint: "↗" } : {}),
      run: () => {
        if (l.newTab) window.open(l.url, "_blank", "noopener,noreferrer");
        else void flushScratchpad().then(() => location.assign(l.url));
      },
    })),
  );

  const locked = viewsLocked();
  const view = activeView();
  if (view) {
    cs.push({ id: "view-refresh", label: "Refresh from Jira", group: "View", keywords: ["reload"], run: () => void doRefresh() });
    const mode = viewMode(view.id);
    cs.push({
      id: "view-mode",
      label: mode === "analysis" ? "Show tickets" : "Show analysis",
      group: "View",
      keywords: ["analysis", "charts", "tickets", "table"],
      run: () => setViewMode(view.id, mode === "analysis" ? "tickets" : "analysis"),
    });
    if (!locked) {
      cs.push(
        { id: "view-jql", label: "Edit JQL", group: "View", keywords: ["query"], run: () => startJqlEdit(view) },
        { id: "view-edit", label: "Edit view…", group: "View", keywords: ["columns", "settings"], run: () => editView(view) },
      );
    }
    if (jiraBaseUrl) {
      const url = jiraSearchUrl(jiraBaseUrl, view.jql);
      cs.push({ id: "view-open-jira", label: "Open JQL in Jira", group: "View", keywords: ["query"], hint: "↗", run: () => window.open(url, "_blank", "noopener,noreferrer") });
    }
    if (!locked && views.length > 1) cs.push({ id: "view-delete", label: "Delete view…", group: "View", keywords: ["remove"], run: () => void confirmDeleteView(view) });
  }
  if (activeId === BOARD_TAB) cs.push({ id: "board-refresh", label: "Refresh board", group: "Kanban", keywords: ["reload", "jira"], run: () => void refreshBoard() });
  if (!locked && columns) cs.push({ id: "view-add", label: "Add view…", group: "View", keywords: ["new", "tab"], run: () => editView(null) });

  cs.push(
    { id: "reading-add", label: "Add a link…", group: "Reading", keywords: ["url", "confluence"], run: () => {
      if (activeId !== READING_TAB) selectTab(READING_TAB);
      setTimeout(focusReadingUrl, 0); // after the tab's (possibly view-transitioned) paint
    } },
    ...readingConfig.statuses.map((st): PaletteCommand => ({ id: `reading-show-${st}`, label: `Show ${st}`, group: "Reading", keywords: ["status"], run: () => {
      if (activeId !== READING_TAB) selectTab(READING_TAB);
      setReadingStatus(st);
    } })),
  );

  const theme = currentTheme();
  cs.push(...THEMES.map((t): PaletteCommand => ({ id: `theme-${t.id}`, label: t.name, group: "Theme", keywords: ["colour", "color"], current: t.id === theme, run: () => saveTheme(t.id) })));
  return cs;
}
initPalette(paletteCommands);

setInterval(() => {
  const el = document.querySelector(".last-refreshed");
  if (el) el.textContent = `Last refreshed ${relativeTime(activeId === BOARD_TAB ? boardData?.fetchedAt ?? null : fetchedAt)}`;
}, 30_000); // keep "last refreshed" fresh
connectLive(onLive);
void loadConfig();
void loadOrphans();
void loadBoard();
void loadReading(); // the reading panel can open from any tab (a ticket's Reading section), so its config is needed early
