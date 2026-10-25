import type { Row, Ticket } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { isMenuOpen, menuButton } from "./viewMenu.ts";
import { api, type CopyKind, type TicketResponse } from "./api.ts";
import { copyToClipboard, h, relativeTime, setHtml } from "./dom.ts";
import { editNote, isEditing } from "./editors.ts";
import { motionAllowed, motionMs } from "./motion.ts";
import { groupLinks, sprintLabel } from "./ticketDetails.ts";

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
let fetchNotFound = false; // the server's 404 message is shown as-is
let loading = false;
let diskNotice = false;
let fetchSeq = 0;
let lastFocus: Element | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
// A closed drawer still playing its exit animation; removed on animationend (or the timeout), or reused by a re-open.
let closing: { el: HTMLElement; cancel: () => void; finish: () => void } | null = null;

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
    shell = reclaimClosing() ?? h("div", { class: "dr-shell" });
    if (!shell.isConnected) document.body.append(shell);
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
  dismiss(shell);
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

/** Plays the exit animation, then removes the shell; at once when motion is off. */
function dismiss(el: HTMLElement): void {
  closing?.finish(); // only one drawer is ever closing
  if (!motionAllowed()) {
    el.remove();
    return;
  }
  el.classList.add("dr-closing");
  const panel = el.querySelector(".dr-panel");
  const onEnd = (e: Event) => {
    if (e.target === panel) finish();
  };
  const cancel = () => {
    clearTimeout(timer);
    el.removeEventListener("animationend", onEnd);
    if (closing?.el === el) closing = null;
  };
  const finish = () => {
    cancel();
    el.remove();
  };
  const timer = setTimeout(finish, motionMs("--motion-exit", 240) + 50);
  el.addEventListener("animationend", onEnd);
  closing = { el, cancel, finish };
}

/** A re-open during the exit animation keeps the same shell: cancel its removal and play the entrance again. */
function reclaimClosing(): HTMLElement | null {
  if (!closing) return null;
  const { el } = closing;
  closing.cancel();
  el.classList.remove("dr-closing");
  el.replaceChildren(); // render() builds a fresh backdrop + panel, whose entrance animations then play
  return el;
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
  return star.disabled ? (star.locked ? "board.yaml has an error" : "Board unavailable") : on ? "Remove from Kanban" : "Add to Kanban";
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
    // A moved ticket opened by its old key: notes and star must target the canonical key.
    if (res.detail.ticket.key !== key) openKey = res.detail.ticket.key;
  } catch (e) {
    if (seq !== fetchSeq || key !== openKey) return;
    fetchError = (e as Error).message;
    fetchNotFound = (e as { status?: number }).status === 404;
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
  if (isEditing() || isMenuOpen() || document.querySelector("dialog[open]")) return;
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

function copyMenu(key: string): HTMLElement {
  const copy = (kind: CopyKind) => async () => toast((await copyToClipboard(() => api.copy(key, kind))) ? "Copied" : "Copy failed");
  return menuButton({
    label: "Copy",
    title: `Copy ${key}`,
    leadingIcon: icon("square2Stack", "btn-svg"),
    items: [
      { label: "Ticket", title: "Copy the ticket as markdown", onSelect: copy("ticket") },
      { label: "My notes", title: "Copy my notes", onSelect: copy("notes") },
      { label: "Ticket + notes for Claude", title: "Copy the ticket, my notes and the groom output", onSelect: copy("both") },
      { label: "Groom prompt for Claude", title: "Copy the groom prompt", onSelect: copy("prompt") },
    ],
  });
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

/** A ticket key that opens in this drawer (Jira itself stays one click away via Open). */
function keyLink(key: string, summary?: string): HTMLElement {
  return h("button", { type: "button", class: "dr-keylink", title: summary ? `${key} · ${summary}` : `Open ${key}`, onclick: () => openDrawer(key) },
    h("code", { class: "key" }, key), summary ? h("span", { class: "dr-keylink-text" }, summary) : null);
}

function detailsSection(t: Ticket): HTMLElement {
  const none = () => h("span", { class: "text-muted" }, "—");
  const field = (label: string, value: string | HTMLElement | null) =>
    [h("dt", {}, label), h("dd", {}, value === null || value === "" ? none() : value)];
  const links = groupLinks(t);
  const sprint = sprintLabel(t);
  return section("Details", h("dl", { class: "dr-details" },
    ...field("Type", t.type),
    ...field("Priority", t.priority),
    ...field("Assignee", t.assignee ?? h("span", { class: "text-muted" }, "Unassigned")),
    ...field("Reporter", t.reporter),
    ...field("Parent", t.parent ? keyLink(t.parent.key, t.parent.summary) : null),
    ...field("Sprint", sprint),
    ...field("Labels", t.labels.length ? h("span", { class: "dr-labels" }, ...t.labels.map((l) => h("span", { class: "pill" }, l))) : null),
    ...field("Components", t.components?.length ? h("span", { class: "dr-labels" }, ...t.components.map((c) => h("span", { class: "pill" }, c))) : null),
    ...field("Updated", t.updated ? h("span", { title: t.updated }, relativeTime(t.updated)) : null),
    ...links.flatMap((g) => field(g.phrase.charAt(0).toUpperCase() + g.phrase.slice(1), h("span", { class: "dr-labels" }, ...g.keys.map((k) => keyLink(k))))),
  ));
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
      box.append(h("span", { class: "text-muted" }, "No groom output yet. Use Copy → Groom prompt for Claude, then run it in Claude."), h("code", { class: "dr-path" }, payload.groomPath));
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
      copyMenu(key),
      t ? h("a", { class: "btn btn-icon", href: t.url, target: "_blank", rel: "noopener", title: "Open in Jira" }, "Open", icon("arrowTopRightOnSquare", "btn-svg")) : null,
    ),
  );

  const left = h("div", { class: "dr-col" });
  if (t) left.append(detailsSection(t));
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
    left.append(h("div", { class: "error-bar", role: "alert" }, fetchNotFound ? fetchError : `Could not load ticket detail: ${fetchError}`));
  } else if (loading) {
    left.append(h("p", { class: "text-muted" }, "Loading…"));
  }

  const right = h("div", { class: "dr-col" }, noteSection(key, row), groomSection(row));
  const body = h("div", { class: "dr-body" }, left, right);
  const hadFocus = shell.contains(document.activeElement);
  // Backdrop and panel persist across re-renders, so their entrance animations play once per open, not on every refetch.
  let panel = shell.querySelector<HTMLElement>(":scope > .dr-panel");
  if (!panel) {
    panel = h("aside", { class: "dr-panel", role: "dialog", tabindex: "-1" });
    shell.replaceChildren(h("div", { class: "dr-backdrop", onclick: closeDrawer }), panel);
  }
  panel.setAttribute("aria-label", `Ticket ${key}`);
  panel.replaceChildren(header, body);
  body.scrollTop = prevScroll;
  if (hadFocus || document.activeElement === document.body) panel.focus();
}
