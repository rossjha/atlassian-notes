import type { Row } from "../shared/types.ts";
import { api, type CopyKind, type TicketResponse } from "./api.ts";
import { copyToClipboard, h, setHtml } from "./dom.ts";
import { editNote, isEditing } from "./editors.ts";

export interface DrawerHooks {
  /** The current table row for a key, if it is in the active view. */
  getRow(key: string): Row | undefined;
  /** Called after the drawer saved a note, so the table can reload. */
  onNoteSaved(): void;
  /** Present when the personal board is available. `disabled` is read live, on every render and sync. */
  star?: { isStarred(key: string): boolean; toggle(key: string): void; readonly disabled: boolean; readonly locked?: boolean };
  /** A note was saved in the drawer. `openedFromSearch` is captured when the editor opened. */
  onNoteSavedInDrawer?(key: string, body: string, openedFromSearch: boolean): void;
}

let hooks: DrawerHooks = { getRow: () => undefined, onNoteSaved: () => {} };
let fromSearch = false; // per drawer-open; cleared on close and on a non-search reopen
let shell: HTMLElement | null = null;
let openKey: string | null = null;
let payload: TicketResponse | null = null;
let fetchError: string | null = null;
let loading = false;
let diskNotice = false;
let fetchSeq = 0;
let lastFocus: Element | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function configureDrawer(next: DrawerHooks): void {
  hooks = next;
}

export function currentDrawerKey(): string | null {
  return openKey;
}

export function openDrawer(key: string, opts: { fromSearch?: boolean } = {}): void {
  if (openKey === key && shell) {
    if (!opts.fromSearch) fromSearch = false;
    shell.querySelector<HTMLElement>(".dr-panel")?.focus();
    return;
  }
  if (!shell) lastFocus = document.activeElement;
  fromSearch = opts.fromSearch === true;
  openKey = key;
  payload = null;
  fetchError = null;
  diskNotice = false;
  if (!shell) {
    shell = h("div", { class: "dr-shell" });
    document.body.append(shell);
    document.addEventListener("keydown", onKeydown, true);
  }
  render();
  shell.querySelector<HTMLElement>(".dr-panel")?.focus();
  void load();
}

export function closeDrawer(): void {
  if (!shell) return;
  const key = openKey;
  seqBump();
  shell.remove();
  shell = null;
  openKey = null;
  payload = null;
  fromSearch = false;
  document.removeEventListener("keydown", onKeydown, true);
  const link = key ? document.querySelector<HTMLElement>(`a[data-open="${CSS.escape(key)}"]`) : null;
  const target = link ?? (lastFocus instanceof HTMLElement && lastFocus.isConnected ? lastFocus : null);
  target?.focus();
  lastFocus = null;
}

/** Live note/groom events: refetch, but never replace an open editor. */
export function drawerOnLive(key: string): void {
  if (key !== openKey) return;
  if (isEditing()) {
    diskNotice = true;
    renderNotice();
    return;
  }
  void load();
}

function starTitle(star: NonNullable<DrawerHooks["star"]>, on: boolean): string {
  return star.disabled ? (star.locked ? "board.yaml has an error" : "Board unavailable") : on ? "Remove from my board" : "Add to my board";
}

function starButton(key: string): HTMLElement | null {
  const star = hooks.star;
  if (!star) return null;
  const btn = h("button", { type: "button", class: "star-btn dr-star", onclick: () => star.toggle(key) });
  applyStar(btn, key, star);
  return btn;
}

function applyStar(btn: HTMLElement, key: string, star: NonNullable<DrawerHooks["star"]>): void {
  const on = star.isStarred(key);
  btn.className = `star-btn dr-star${on ? " on" : ""}`;
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", `Star ${key}`);
  btn.setAttribute("title", starTitle(star, on));
  btn.textContent = on ? "★" : "☆";
  if (star.disabled) btn.setAttribute("disabled", "");
  else btn.removeAttribute("disabled");
}

/** Board state changed: update the ★ in place (no re-render, so an open note editor is untouched). */
export function drawerSyncStar(): void {
  const star = hooks.star;
  const btn = shell?.querySelector<HTMLElement>(".dr-star");
  if (star && btn && openKey) applyStar(btn, openKey, star);
}

function seqBump(): number {
  return ++fetchSeq;
}

async function load(): Promise<void> {
  const key = openKey;
  if (!key) return;
  const seq = seqBump();
  loading = payload === null;
  try {
    const res = await api.ticket(key);
    if (seq !== fetchSeq || key !== openKey) return;
    payload = res;
    fetchError = null;
  } catch (e) {
    if (seq !== fetchSeq || key !== openKey) return;
    fetchError = (e as Error).message;
  }
  loading = false;
  diskNotice = false;
  if (isEditing()) {
    diskNotice = true;
    renderNotice();
    return;
  }
  render();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  // Capture phase: an open editor still counts as editing, so it cancels first.
  if (isEditing() || document.querySelector("dialog[open]")) return;
  e.preventDefault();
  closeDrawer();
}

function toast(text: string): void {
  document.querySelector(".dr-toast")?.remove();
  clearTimeout(toastTimer);
  const el = h("div", { class: "dr-toast", role: "status" }, text);
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 1500);
}

function copyButton(key: string, kind: CopyKind, label: string): HTMLElement {
  return h("button", {
    type: "button",
    class: "btn",
    onclick: async () => toast((await copyToClipboard(() => api.copy(key, kind))) ? "Copied" : "Copy failed"),
  }, label);
}

function rowFor(key: string): Row | null {
  const live = hooks.getRow(key);
  if (live) return live;
  if (!payload) return null;
  return {
    ticket: payload.detail.ticket,
    note: payload.note ? { body: payload.note.body, mtimeMs: payload.note.mtimeMs } : null,
    groom: null,
    custom: {},
    flags: { jiraNewerThanNote: false, jiraNewerThanGroom: false },
  };
}

function updatedMarker(row: Row | null): HTMLElement | null {
  if (!row) return null;
  const { jiraNewerThanNote: n, jiraNewerThanGroom: g } = row.flags;
  if (!n && !g) return null;
  const what = n && g ? "your note and the groom" : n ? "your note" : "the groom";
  return h("span", { class: "dr-updated", title: "Jira changed after this was last written" }, `Jira updated since ${what}`);
}

function noticeEl(): HTMLElement {
  const el = h("div", { class: "dr-notice", role: "status" }, "Changed on disk. Your open editor was left alone; close it to see the latest.");
  el.hidden = !diskNotice;
  return el;
}

function renderNotice(): void {
  const el = shell?.querySelector<HTMLElement>(".dr-notice");
  if (el) el.hidden = !diskNotice;
}

function section(title: string, body: HTMLElement): HTMLElement {
  return h("section", { class: "dr-section" }, h("h3", { class: "dr-h" }, title), body);
}

function htmlBox(html: string, empty: string): HTMLElement {
  const box = h("div", { class: "dr-prose" });
  if (html.trim()) setHtml(box, html);
  else box.append(h("span", { class: "text-muted" }, empty));
  return box;
}

function noteSection(key: string, row: Row | null): HTMLElement {
  const cell = h("div", { class: "dr-note" });
  const show = (plainOnly: boolean): void => {
    if (payload && !plainOnly) cell.replaceChildren(htmlBox(payload.noteHtml, "No note yet. Click to add one."));
    else if (row?.note?.body) cell.replaceChildren(h("div", { class: "dr-prose dr-plain" }, row.note.body));
    else cell.replaceChildren(h("span", { class: "text-muted" }, "No note yet. Click to add one."));
  };
  show(false);
  if (row) {
    cell.classList.add("dr-editable");
    cell.addEventListener("click", (e) => {
      if (cell.querySelector(".editor-wrap") || (e.target as Element).closest("a,button")) return;
      const before = row.note; // editNote assigns a new object on a successful save
      // Captured now: closing the drawer while a blur-triggered save is in flight resets `fromSearch`.
      const openedFromSearch = fromSearch;
      editNote(cell, row, () => {
        hooks.onNoteSaved();
        if (row.note && row.note !== before) hooks.onNoteSavedInDrawer?.(key, row.note.body, openedFromSearch);
        diskNotice = false;
        renderNotice();
        show(true); // until the refetch below brings the rendered HTML
        void load();
      }, { rows: 16 });
    });
  }
  return h("div", {}, section(`My note (${key})`, cell), noticeEl());
}

function groomSection(row: Row | null): HTMLElement {
  const box = h("div", { class: "dr-groom" });
  if (payload) {
    if (payload.groom) {
      box.append(
        h("div", { class: "dr-groom-head" },
          payload.groom.summary.readiness ? h("span", { class: "pill groom-readiness" }, payload.groom.summary.readiness) : null,
          h("code", { class: "text-muted", title: "Groom file" }, payload.groomPath),
        ),
        htmlBox(payload.groomHtml, ""),
      );
    } else {
      box.append(h("span", { class: "text-muted" }, "No groom output yet. Use Copy groom prompt, then run it in Claude."), h("code", { class: "dr-path" }, payload.groomPath));
    }
  } else if (row?.groom) {
    box.append(h("div", { class: "dr-prose dr-plain" }, row.groom.summary));
  } else {
    box.append(h("span", { class: "text-muted" }, "No groom output yet."));
  }
  return section("Groom", box);
}

function render(): void {
  if (!shell || !openKey) return;
  const key = openKey;
  const row = rowFor(key);
  const t = payload?.detail.ticket ?? row?.ticket;
  const prevScroll = shell.querySelector(".dr-body")?.scrollTop ?? 0;

  const header = h("header", { class: "dr-head" },
    h("div", { class: "dr-title" },
      starButton(key),
      h("code", { class: "key" }, key),
      h("span", { class: "dr-summary" }, t?.summary ?? ""),
      t ? h("span", { class: `pill cat-${t.statusCategory.replace(/\W+/g, "-").toLowerCase()}` }, t.status) : null,
      t && t.storyPoints !== null ? h("span", { class: "pill num" }, `${t.storyPoints} pts`) : null,
      updatedMarker(row),
      h("span", { class: "dr-spacer" }),
      h("button", { type: "button", class: "btn", "aria-label": "Close", onclick: closeDrawer }, "×"),
    ),
    h("div", { class: "dr-actions" },
      copyButton(key, "ticket", "Copy ticket"),
      copyButton(key, "notes", "Copy notes"),
      copyButton(key, "both", "Copy both for Claude"),
      copyButton(key, "prompt", "Copy groom prompt"),
      t ? h("a", { class: "btn", href: t.url, target: "_blank", rel: "noopener" }, "Open in Jira ↗") : null,
    ),
  );

  const left = h("div", { class: "dr-col" });
  if (payload) {
    left.append(section("Description", htmlBox(payload.html.description, "No description.")));
    if (payload.html.acceptanceCriteria.trim()) left.append(section("Acceptance criteria", htmlBox(payload.html.acceptanceCriteria, "")));
    const comments = payload.detail.comments;
    left.append(section(`Comments (${comments.length})`, h("div", {},
      ...(comments.length === 0 ? [h("span", { class: "text-muted" }, "No comments.")] : comments.map((c, i) =>
        h("div", { class: "dr-comment" },
          h("div", { class: "dr-comment-head text-muted" }, `${c.author} · ${c.created.slice(0, 10)}`),
          htmlBox(payload!.html.comments[i] ?? "", ""),
        ))),
    )));
  } else if (fetchError) {
    left.append(h("div", { class: "error-bar", role: "alert" }, `Could not load ticket detail: ${fetchError}`));
  } else if (loading) {
    left.append(h("p", { class: "text-muted" }, "Loading…"));
  }

  const right = h("div", { class: "dr-col" }, noteSection(key, row), groomSection(row));
  const body = h("div", { class: "dr-body" }, left, right);
  const panel = h("aside", { class: "dr-panel", role: "dialog", "aria-label": `Ticket ${key}`, tabindex: "-1" }, header, body);
  const hadFocus = shell.contains(document.activeElement);
  shell.replaceChildren(h("div", { class: "dr-backdrop", onclick: closeDrawer }), panel);
  body.scrollTop = prevScroll;
  if (hadFocus || document.activeElement === document.body) panel.focus();
}
