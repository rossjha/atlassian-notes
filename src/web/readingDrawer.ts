// The reading item side panel: fields, reading prompts, the user's note, Claude's summary, Copy and Delete.
// Shares the ticket panel's shell and classes (dr-*); only one of the two is ever open.
import { readingCardKey } from "../shared/reading.ts";
import type { ReadingConfig, ReadingItem } from "../shared/types.ts";
import { api, type ReadingCopyKind, type ReadingItemResponse, type ReadingPatch } from "./api.ts";
import { copyToClipboard, h, relativeTime, setHtml } from "./dom.ts";
import { closeDrawer, toast, type DrawerHooks } from "./drawer.ts";
import { editMarkdown, isEditing } from "./editors.ts";
import { icon } from "./icons.ts";
import { motionAllowed, motionMs } from "./motion.ts";
import { isValidKeyClient } from "../shared/rowOps.ts";
import { confirmDialog, isMenuOpen, menuButton } from "./viewMenu.ts";

export interface ReadingDrawerHooks {
  getItem(id: string): ReadingItem | undefined;
  config(): ReadingConfig;
  /** reading.yaml is broken: field edits are refused until it is fixed (the note stays editable). */
  lockedReason(): string | null;
  star: DrawerHooks["star"];
  /** Something about the item changed (saved here): reload the list/board. */
  onChanged(): void;
  openTicket(key: string): void;
}

let hooks: ReadingDrawerHooks | null = null;
let shell: HTMLElement | null = null;
let openId: string | null = null;
let payload: ReadingItemResponse | null = null;
let fetchError: string | null = null;
let fetchSeq = 0;
let diskNotice = false;
let lastFocus: Element | null = null;

export function configureReadingDrawer(next: ReadingDrawerHooks): void {
  hooks = next;
}

export function currentReadingId(): string | null {
  return openId;
}

export function openReadingDrawer(id: string): void {
  closeDrawer(); // one panel at a time
  if (openId === id && shell) {
    shell.querySelector<HTMLElement>(".dr-panel")?.focus();
    return;
  }
  if (!shell) {
    lastFocus = document.activeElement;
    shell = h("div", { class: "dr-shell reading-drawer" });
    document.body.append(shell);
    document.addEventListener("keydown", onKeydown, true);
  }
  openId = id;
  payload = null;
  fetchError = null;
  diskNotice = false;
  render();
  shell.querySelector<HTMLElement>(".dr-panel")?.focus();
  void load();
}

export function closeReadingDrawer(): void {
  if (!shell) return;
  const el = shell;
  fetchSeq++;
  shell = null;
  openId = null;
  payload = null;
  document.removeEventListener("keydown", onKeydown, true);
  if (motionAllowed()) {
    el.classList.add("dr-closing");
    setTimeout(() => el.remove(), motionMs("--motion-exit", 240) + 50);
  } else {
    el.remove();
  }
  if (lastFocus instanceof HTMLElement && lastFocus.isConnected) lastFocus.focus();
  lastFocus = null;
}

/** A live change to this item: refetch, but never under an open editor. */
export function readingDrawerOnLive(id: string): void {
  if (id !== openId) return;
  if (isEditing()) {
    diskNotice = true;
    renderNotice();
    return;
  }
  void load();
}

/** Board changed: refresh the ★ in place. */
export function readingDrawerSyncStar(): void {
  const btn = shell?.querySelector<HTMLElement>(".dr-star");
  if (btn && openId) applyStar(btn, openId);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (isEditing() || isMenuOpen() || document.querySelector("dialog[open]")) return;
  if ((e.target as Element | null)?.closest(".rd-inline")) return; // an inline title/URL/ticket input handles its own Esc
  e.preventDefault();
  closeReadingDrawer();
}

async function load(): Promise<void> {
  const id = openId;
  if (!id) return;
  const seq = ++fetchSeq;
  try {
    const res = await api.readingItem(id);
    if (seq !== fetchSeq || id !== openId) return;
    payload = res;
    fetchError = null;
  } catch (e) {
    if (seq !== fetchSeq || id !== openId) return;
    fetchError = (e as Error).message;
  }
  diskNotice = false;
  if (isEditing()) {
    diskNotice = true;
    renderNotice();
    return;
  }
  render();
}

function item(): ReadingItem | null {
  if (!openId) return null;
  return payload?.item ?? hooks?.getItem(openId) ?? null;
}

async function saveFields(patch: ReadingPatch): Promise<void> {
  const id = openId;
  if (!id) return;
  try {
    const r = await api.saveReadingFields(id, patch);
    if (r.kind === "invalid") toast(r.error);
    else if (r.kind === "conflict") toast("Changed on disk; reloaded");
  } catch (e) {
    toast((e as Error).message);
  }
  hooks?.onChanged();
  if (id === openId) void load();
}

function applyStar(btn: HTMLElement, id: string): void {
  const star = hooks?.star;
  if (!star) return;
  const key = readingCardKey(id);
  const on = star.isStarred(key);
  btn.className = `star-btn dr-star${on ? " on" : ""}`;
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", "Star this item");
  btn.setAttribute("title", star.disabled ? (star.locked ? "board.yaml has an error" : "Board unavailable") : on ? "Remove from Kanban" : "Add to Kanban");
  btn.textContent = on ? "★" : "☆";
  if (star.disabled) btn.setAttribute("disabled", "");
  else btn.removeAttribute("disabled");
}

/** Text shown as a button; click turns it into an input (Enter saves, Esc cancels). */
function inlineText(value: string, label: string, display: HTMLElement, disabledReason: string | null, onSave: (v: string) => void): HTMLElement {
  const wrap = h("span", { class: "rd-inline-wrap" });
  const show = () => {
    const btn = h("button", { type: "button", class: "rd-inline-btn", title: disabledReason ?? `Edit ${label.toLowerCase()}` }, display);
    if (disabledReason) btn.setAttribute("disabled", "");
    btn.addEventListener("click", () => {
      const input = h("input", { type: "text", class: "rd-inline jql", "aria-label": label, spellcheck: "false" }) as HTMLInputElement;
      input.value = value;
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (save && v !== "" && v !== value) onSave(v);
        else show();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
      wrap.replaceChildren(input);
      input.focus();
      input.select();
    });
    wrap.replaceChildren(btn);
  };
  show();
  return wrap;
}

function selectField(label: string, value: string | null, options: string[], allowNone: boolean, disabledReason: string | null, onChange: (v: string | null) => void): HTMLElement {
  const sel = h("select", { class: "reading-filter", "aria-label": label }) as HTMLSelectElement;
  if (allowNone) sel.append(h("option", { value: "" }, "—"));
  for (const o of options) sel.append(h("option", { value: o }, o));
  if (value !== null && value !== "" && !options.includes(value)) {
    const odd = h("option", { value }, `${value} (not in reading.yaml)`) as HTMLOptionElement;
    odd.disabled = true;
    sel.append(odd);
  }
  sel.value = value ?? "";
  if (disabledReason) {
    sel.disabled = true;
    sel.title = disabledReason;
  }
  sel.addEventListener("change", () => onChange(sel.value === "" ? null : sel.value));
  return sel;
}

function ticketsField(it: ReadingItem, disabledReason: string | null): HTMLElement {
  const box = h("span", { class: "dr-labels rd-tickets" });
  const save = (tickets: string[]) => void saveFields({ tickets });
  for (const k of it.tickets) {
    box.append(h("span", { class: "rd-chip" },
      h("button", { type: "button", class: "key", title: `Open ${k}`, onclick: () => hooks?.openTicket(k) }, k),
      disabledReason ? null : h("button", { type: "button", class: "rd-chip-x", title: `Unlink ${k}`, "aria-label": `Unlink ${k}`, onclick: () => save(it.tickets.filter((t) => t !== k)) }, "✕"),
    ));
  }
  if (!disabledReason) {
    const add = h("button", { type: "button", class: "link-btn", onclick: () => {
      const input = h("input", { type: "text", class: "rd-inline jql rd-key-input", placeholder: "ABC-123", "aria-label": "Ticket key", spellcheck: "false" }) as HTMLInputElement;
      const hint = h("span", { class: "ticket-search-hint" });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          render();
        } else if (e.key === "Enter") {
          e.preventDefault();
          const key = input.value.trim().toUpperCase();
          if (!isValidKeyClient(key)) {
            hint.textContent = "Enter a key like ABC-123";
            return;
          }
          if (!it.tickets.includes(key)) save([...it.tickets, key]);
          else render();
        }
      });
      add.replaceWith(input, hint);
      input.focus();
    } }, "+ add");
    box.append(add);
  }
  return box;
}

function copyMenu(id: string): HTMLElement {
  const copy = (kind: ReadingCopyKind) => async () => toast((await copyToClipboard(() => api.readingCopy(id, kind))) ? "Copied" : "Copy failed");
  return menuButton({
    label: "Copy",
    title: "Copy",
    leadingIcon: icon("square2Stack", "btn-svg"),
    items: [
      { label: "Link", title: "Copy a markdown link", onSelect: copy("link") },
      { label: "My note", title: "Copy my note", onSelect: copy("note") },
      { label: "Item + note for Claude", title: "Copy the item, my note and any Claude summary", onSelect: copy("both") },
      { label: "Prompt for Claude", title: "Copy the reading prompt for Claude", onSelect: copy("prompt") },
    ],
  });
}

function moreMenu(it: ReadingItem): HTMLElement {
  return menuButton({
    label: "More",
    title: "More actions",
    items: [{
      label: "Delete…",
      title: "Move this item to the trash",
      onSelect: () => void (async () => {
        const ok = await confirmDialog({
          title: `Delete "${it.title}"?`,
          body: "Moves this item, your note and any Claude summary to .cache/trash/reading in your notes folder, and removes it from your Kanban.",
          confirmLabel: "Delete",
        });
        if (!ok) return;
        try {
          await api.deleteReading(it.id);
          closeReadingDrawer();
          toast("Moved to the trash");
        } catch (e) {
          toast((e as Error).message);
        }
        hooks?.onChanged();
      })(),
    }],
  });
}

function section(title: string, body: HTMLElement): HTMLElement {
  return h("section", { class: "dr-section" }, h("h3", { class: "dr-h" }, title), body);
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

function noteSection(it: ReadingItem): HTMLElement {
  const cell = h("div", { class: "dr-note dr-editable" });
  const show = () => {
    if (payload?.noteHtml.trim()) {
      const box = h("div", { class: "dr-prose" });
      setHtml(box, payload.noteHtml);
      cell.replaceChildren(box);
    } else if (it.note.trim()) cell.replaceChildren(h("div", { class: "dr-prose dr-plain" }, it.note));
    else cell.replaceChildren(h("span", { class: "text-muted" }, "No note yet. Click to add one."));
  };
  show();
  if (it.parseError) {
    cell.classList.remove("dr-editable");
    cell.replaceChildren(h("span", { class: "text-muted" }, "This file's front matter could not be parsed. Fix it by hand (e.g. in Obsidian), then it can be edited here again."));
    return section("My note", cell);
  }
  let note = { body: it.note, mtimeMs: it.mtimeMs };
  cell.addEventListener("click", (e) => {
    if (cell.querySelector(".editor-wrap") || (e.target as Element).closest("a,button")) return;
    editMarkdown(cell, {
      label: `Note for ${it.title}`,
      get note() {
        return note;
      },
      async save(body, base, force) {
        const r = await api.saveReadingNote(it.id, body, base, force);
        if (r.kind === "ok") note = { body, mtimeMs: r.mtimeMs };
        return r;
      },
    }, () => {
      hooks?.onChanged();
      diskNotice = false;
      renderNotice();
      void load();
    }, { rows: 16 });
  });
  return h("div", {}, section("My note", cell), noticeEl());
}

function claudeSection(it: ReadingItem): HTMLElement {
  const box = h("div", { class: "dr-groom" });
  if (it.groom) {
    const body = h("div", { class: "dr-prose" });
    if (payload?.groomHtml) setHtml(body, payload.groomHtml);
    else body.append(h("div", { class: "dr-plain" }, it.groom.summary));
    box.append(
      h("div", { class: "dr-groom-head" },
        h("span", { title: it.groom.groomedAt }, `Summarised ${relativeTime(it.groom.groomedAt)}`),
        payload ? h("code", { class: "text-muted" }, payload.groomPath) : null,
      ),
      body,
    );
  } else {
    box.append(h("span", { class: "text-muted" }, "No summary yet. Use Copy → Prompt for Claude, then run it in Claude."));
    if (payload) box.append(h("code", { class: "dr-path" }, payload.groomPath));
  }
  return section("Claude", box);
}

function render(): void {
  if (!shell || !openId) return;
  const it = item();
  const prevScroll = shell.querySelector(".dr-body")?.scrollTop ?? 0;
  const cfg = hooks?.config() ?? { statuses: [], doneStatus: "", categories: [], prompts: [], groomPrompt: "" };
  const locked = it?.parseError ? "This file's front matter could not be parsed" : hooks?.lockedReason() ?? null;

  const star = h("button", { type: "button", class: "star-btn dr-star", onclick: () => hooks?.star?.toggle(readingCardKey(openId!)) });
  applyStar(star, openId);
  const header = h("header", { class: "dr-head" },
    h("div", { class: "dr-title" },
      star,
      icon("eyeglasses", "rd-title-icon"),
      it ? inlineText(it.title, "Title", h("span", { class: "dr-summary" }, it.title), locked, (v) => void saveFields({ title: v })) : h("span", { class: "dr-summary" }, openId),
      it?.status ? h("span", { class: "pill" }, it.status) : null,
      h("span", { class: "dr-spacer" }),
      h("button", { type: "button", class: "btn", "aria-label": "Close", onclick: closeReadingDrawer }, "×"),
    ),
    it
      ? h("div", { class: "dr-actions" },
          copyMenu(it.id),
          it.url ? h("a", { class: "btn btn-icon", href: it.url, target: "_blank", rel: "noopener noreferrer", title: "Open the link" }, "Open", icon("arrowTopRightOnSquare", "btn-svg")) : null,
          moreMenu(it),
        )
      : null,
  );

  const left = h("div", { class: "dr-col" });
  const right = h("div", { class: "dr-col" });
  if (fetchError && !it) left.append(h("div", { class: "error-bar", role: "alert" }, fetchError));
  else if (!it) left.append(h("p", { class: "text-muted" }, "Loading…"));
  else {
    const field = (label: string, value: HTMLElement | string) => [h("dt", {}, label), h("dd", {}, value)];
    left.append(section("Details", h("dl", { class: "dr-details" },
      ...field("Status", selectField("Status", it.status, cfg.statuses, false, locked, (v) => v && void saveFields({ status: v }))),
      ...field("Category", selectField("Category", it.category, cfg.categories, true, locked, (v) => void saveFields({ category: v }))),
      ...field("Tickets", ticketsField(it, locked)),
      ...field("Source", it.source),
      ...field("URL", inlineText(it.url, "URL", h("span", { class: "rd-url" }, it.url), locked, (v) => void saveFields({ url: v }))),
      ...field("Added", h("span", { title: it.created }, relativeTime(it.created))),
      ...field("Updated", h("span", { title: it.updated }, relativeTime(it.updated))),
    )));
    if (cfg.prompts.length) right.append(section("Reading prompts", h("ul", { class: "rd-prompts" }, ...cfg.prompts.map((p) => h("li", {}, p)))));
    right.append(noteSection(it), claudeSection(it));
  }

  const body = h("div", { class: "dr-body" }, left, right);
  const hadFocus = shell.contains(document.activeElement);
  let panel = shell.querySelector<HTMLElement>(":scope > .dr-panel");
  if (!panel) {
    panel = h("aside", { class: "dr-panel", role: "dialog", tabindex: "-1" });
    shell.replaceChildren(h("div", { class: "dr-backdrop", onclick: closeReadingDrawer }), panel);
  }
  panel.setAttribute("aria-label", it ? `Reading: ${it.title}` : "Reading item");
  panel.replaceChildren(header, body);
  body.scrollTop = prevScroll;
  if (hadFocus || document.activeElement === document.body) panel.focus();
}
