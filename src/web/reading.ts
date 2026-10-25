// The Reading tab: a URL bar (paste + Enter adds), one sub-tab per status plus All, filters and the item table.
import { filterReading, readingCardKey, sortReading, type ReadingSortKey } from "../shared/reading.ts";
import type { ReadingConfig, ReadingItem } from "../shared/types.ts";
import { h, relativeTime } from "./dom.ts";
import { icon, linkIcon } from "./icons.ts";

export interface ReadingTabState {
  items: ReadingItem[];
  config: ReadingConfig;
  loaded: boolean;
  /** null = All. */
  status: string | null;
  category: string | null;
  ticket: string | null;
  sort: { by: ReadingSortKey; dir: "asc" | "desc" };
  /** Just added: highlighted once. */
  newId: string | null;
  /** Shown under the URL bar (e.g. not an http(s) link). */
  hint: string | null;
  adding: boolean;
}

export interface ReadingHandlers {
  onAdd(url: string): void;
  onOpen(id: string): void;
  onOpenTicket(key: string): void;
  onStatusTab(status: string | null): void;
  onFilter(f: { category?: string | null; ticket?: string | null }): void;
  onSort(by: ReadingSortKey): void;
  onHintClear(): void;
  star: { isStarred(cardKey: string): boolean; toggle(cardKey: string): void; disabled: boolean; locked?: boolean };
}

// The URL input outlives re-renders, so typing (and focus) survive live updates.
const urlInput = h("input", {
  type: "text",
  class: "jql reading-url",
  placeholder: "Paste a link and press Enter…",
  "aria-label": "Add a link to the reading list",
  autocomplete: "off",
  spellcheck: "false",
}) as HTMLInputElement;
let current: ReadingHandlers | null = null;
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (url) current?.onAdd(url);
  } else if (e.key === "Escape") {
    urlInput.value = "";
    current?.onHintClear();
  }
});
urlInput.addEventListener("input", () => current?.onHintClear());

export function focusReadingUrl(): void {
  urlInput.focus();
  urlInput.select();
}

export function clearReadingUrl(): void {
  urlInput.value = "";
}

const COLUMNS: { id: ReadingSortKey; label: string }[] = [
  { id: "title", label: "Title" },
  { id: "status", label: "Status" },
  { id: "category", label: "Category" },
  { id: "tickets", label: "Tickets" },
  { id: "groomed", label: "Groomed" },
  { id: "updated", label: "Updated" },
  { id: "created", label: "Added" },
];

function select(label: string, value: string | null, options: string[], onChange: (v: string | null) => void): HTMLElement {
  const sel = h("select", { class: "reading-filter", "aria-label": label }) as HTMLSelectElement;
  sel.append(h("option", { value: "" }, `${label}: all`), ...options.map((o) => h("option", { value: o }, `${label}: ${o}`)));
  sel.value = value ?? "";
  sel.addEventListener("change", () => onChange(sel.value === "" ? null : sel.value));
  return sel;
}

function starCell(item: ReadingItem, star: ReadingHandlers["star"]): HTMLElement {
  const key = readingCardKey(item.id);
  const on = star.isStarred(key);
  const btn = h("button", {
    type: "button",
    class: `star-btn${on ? " on" : ""}`,
    "aria-pressed": String(on),
    "aria-label": `Star ${item.title}`,
    title: star.disabled ? (star.locked ? "board.yaml has an error" : "Board unavailable") : on ? "Remove from Kanban" : "Add to Kanban",
    onclick: () => star.toggle(key),
  }, on ? "★" : "☆");
  if (star.disabled) btn.setAttribute("disabled", "");
  return h("td", { class: "col-star" }, btn);
}

function timeCell(iso: string | null, title?: string): HTMLElement {
  return h("td", { class: "reading-time" }, iso ? h("span", { title: title ?? iso }, relativeTime(iso)) : h("span", { class: "text-muted" }, "—"));
}

function row(item: ReadingItem, s: ReadingTabState, handlers: ReadingHandlers): HTMLElement {
  const tr = h("tr", { class: item.id === s.newId ? "reading-new" : "", "data-reading-id": item.id },
    starCell(item, handlers.star),
    h("td", { class: "reading-title-cell" },
      h("div", { class: "reading-title" },
        item.parseError ? h("span", { class: "stale-dot reading-error", title: `Front matter could not be parsed: ${item.parseError}` }) : null,
        h("button", { type: "button", class: "reading-open", title: "Open details", onclick: () => handlers.onOpen(item.id) }, item.title),
        item.url
          ? h("a", { class: "reading-ext", href: item.url, target: "_blank", rel: "noopener noreferrer", title: "Open the link", "aria-label": `Open ${item.title} in a new tab` },
              icon("arrowTopRightOnSquare", "reading-ext-svg"))
          : null,
      ),
    ),
    h("td", {}, item.status ? h("span", { class: "pill reading-status" }, item.status) : null),
    h("td", {}, item.category ? h("span", { class: "pill" }, item.category) : null),
    h("td", { class: "reading-tickets" },
      ...item.tickets.map((k) => h("button", { type: "button", class: "key", title: `Open ${k}`, onclick: () => handlers.onOpenTicket(k) }, k))),
    timeCell(item.groom?.groomedAt ?? null, item.groom?.summary),
    timeCell(item.updated),
    timeCell(item.created),
  );
  return tr;
}

export function renderReading(container: HTMLElement, s: ReadingTabState, handlers: ReadingHandlers): void {
  current = handlers;
  const hadFocus = document.activeElement === urlInput;
  const known = new Set(s.config.statuses);
  const count = (st: string) => s.items.filter((i) => i.status === st).length;
  const tab = (label: string, value: string | null, n: number) =>
    h("button", {
      type: "button",
      class: `reading-subtab${s.status === value ? " active" : ""}`,
      "aria-pressed": String(s.status === value),
      onclick: () => handlers.onStatusTab(value),
    }, label, h("span", { class: "reading-count" }, String(n)));
  const statusOk = s.status === null || known.has(s.status);
  const status = statusOk ? s.status : null;

  const tickets = [...new Set(s.items.flatMap((i) => i.tickets))].sort();
  const filtered = filterReading(s.items, { status, category: s.category, ticket: s.ticket });
  const shown = sortReading(filtered, s.sort.by, s.sort.dir);

  const hint = h("span", { class: "ticket-search-hint", role: "alert" }, s.hint ?? "");
  hint.hidden = !s.hint;
  const bar = h("div", { class: "reading-bar" },
    h("div", { class: "jql-field" }, linkIcon("link", "jql-icon"), urlInput),
    hint,
  );
  // Never disabled while adding: that would drop focus, and the next paste would go nowhere (onAdd ignores repeats).
  urlInput.setAttribute("aria-busy", String(s.adding));

  const subtabs = h("div", { class: "reading-subtabs", role: "group", "aria-label": "Status" },
    ...s.config.statuses.map((st) => tab(st, st, count(st))),
    tab("All", null, s.items.length),
    h("span", { class: "reading-spacer" }),
    select("Category", s.category, s.config.categories, (v) => handlers.onFilter({ category: v })),
    tickets.length ? select("Ticket", s.ticket, tickets, (v) => handlers.onFilter({ ticket: v })) : null,
  );

  const head = h("tr", {},
    h("th", { class: "col-star", "aria-label": "On Kanban" }, "★"),
    ...COLUMNS.map((c) => {
      const active = s.sort.by === c.id;
      return h("th", { class: active ? "sorted" : "", "aria-sort": active ? (s.sort.dir === "asc" ? "ascending" : "descending") : "none" },
        h("button", { type: "button", class: "th-btn", onclick: () => handlers.onSort(c.id) },
          c.label, active ? h("span", { class: "sort-ind" }, s.sort.dir === "asc" ? " ▲" : " ▼") : null));
    }),
  );
  const table = h("table", { class: "ticket-grid reading-grid" }, h("thead", {}, head), h("tbody", {}, ...shown.map((i) => row(i, s, handlers))));

  const empty = !s.loaded
    ? h("p", { class: "empty-state" }, "Loading…")
    : s.items.length === 0
      ? h("p", { class: "empty-state" }, "Nothing here yet. Paste a link above.")
      : shown.length === 0
        ? h("p", { class: "empty-state" }, status === null ? "Nothing matches these filters." : `Nothing in ${status}.`)
        : null;

  container.replaceChildren(bar, subtabs, h("div", { class: "reading-table" }, table), ...(empty ? [empty] : []));
  if (hadFocus) urlInput.focus();
}
