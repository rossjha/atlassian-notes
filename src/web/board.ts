import { locate } from "../shared/boardOps.ts";
import type { BoardCard, BoardOp, BoardResponse, Row } from "../shared/types.ts";
import { h, relativeTime } from "./dom.ts";
import { icon } from "./icons.ts";
import { refreshButton } from "./icons.ts";
import { editNote, isEditing } from "./editors.ts";

export interface BoardHandlers {
  onOpen(key: string): void;
  onOp(op: BoardOp): void;
  onNoteSaved(): void;
  onRefresh(): void;
  refreshing: boolean;
  /** Current number of cards in the archive column (latest board data), checked when the archive click is confirmed. */
  archiveCount?(): number;
}

const ARCHIVE_CONFIRM_MS = 4000;

let dragKey: string | null = null;
let dragIdleListener: (() => void) | null = null;
let armed: { count: number; timer: ReturnType<typeof setTimeout> } | null = null;
let archiveBtn: HTMLElement | null = null;

/** True while a card is being dragged; callers must not rebuild the DOM under the drag. */
export function isDragging(): boolean {
  return dragKey !== null;
}

/** Called when a drag ends (used to apply deferred re-renders). */
export function onDragIdle(cb: () => void): void {
  dragIdleListener = cb;
}

function archiveLabel(count: number, isArmed: boolean): string {
  return isArmed ? `Archive ${count} ${count === 1 ? "card" : "cards"}?` : "Archive all";
}

function findCardEl(container: HTMLElement, key: string): HTMLElement | null {
  for (const el of container.querySelectorAll<HTMLElement>("[data-card-key]")) {
    if (el.getAttribute("data-card-key") === key) return el;
  }
  return null;
}

function cardEl(
  card: BoardCard,
  column: string,
  data: BoardResponse,
  handlers: BoardHandlers,
  disabled: boolean,
): HTMLElement {
  const label = card.reading ? `Reading: ${card.reading.title}` : card.row ? `${card.key} ${card.row.ticket.summary}` : card.key;
  const el = h("article", { class: `board-card${card.reading !== undefined ? " board-card-reading" : ""}`, tabindex: "0", "data-card-key": card.key, "aria-label": label });
  const remove = h("button", {
    type: "button",
    class: "card-x",
    title: "Remove from Kanban",
    "aria-label": `Remove ${card.reading?.title ?? card.key} from Kanban`,
    onclick: () => handlers.onOp({ op: "remove", key: card.key }),
  }, "✕");
  if (disabled) remove.setAttribute("disabled", "");

  const row: Row | null = card.row;
  if (card.reading !== undefined) {
    // A reading list item: glasses, title and status; it opens the reading panel and has no inline note.
    const r = card.reading;
    el.append(
      h("div", { class: "card-line" },
        icon("eyeglasses", "card-reading-icon"),
        h("button", { type: "button", class: "card-title card-reading-title", title: "Open details", onclick: () => handlers.onOpen(card.key) }, r?.title ?? card.key),
        remove,
      ),
      r
        ? h("div", { class: "card-line card-meta" }, h("span", { class: "pill" }, r.status))
        : h("div", { class: "text-muted" }, "reading item not found"),
    );
  } else if (!row) {
    el.append(
      h("div", { class: "card-line" }, h("button", { type: "button", class: "key card-key", onclick: () => handlers.onOpen(card.key) }, card.key), remove),
      h("div", { class: "text-muted" }, card.missing ? "not found in Jira" : "loading…"),
    );
  } else {
    const t = row.ticket;
    const lineTwo = h("div", { class: "card-line card-meta" },
      h("span", { class: `pill cat-${t.statusCategory.replace(/\W+/g, "-").toLowerCase()}` }, t.status),
      row.groom?.readiness ? h("span", { class: "pill groom-readiness" }, row.groom.readiness) : null,
      row.flags.jiraNewerThanNote ? h("span", { class: "stale-dot card-stale", title: "Jira changed after this note was last edited" }) : null,
    );
    const note = h("div", { class: "card-note" });
    const paintNote = (): void => {
      note.classList.remove("card-note-editing");
      note.classList.toggle("card-note-empty", !row.note?.body);
      note.replaceChildren(row.note?.body ? row.note.body : "+ add note");
    };
    paintNote();
    if (!disabled) {
      note.addEventListener("click", () => {
        if (note.querySelector(".editor-wrap")) return;
        el.draggable = false; // a textarea inside a draggable card can't select text in Firefox
        note.classList.add("card-note-editing");
        editNote(note, row, () => {
          el.draggable = true;
          paintNote(); // the editor leaves its textarea behind if no re-render follows
          handlers.onNoteSaved();
        }, { rows: 4 });
      });
    }
    el.append(
      h("div", { class: "card-line" },
        h("button", { type: "button", class: "key card-key", title: "Open details", onclick: () => handlers.onOpen(t.key) }, t.key),
        h("span", { class: "card-title" }, t.summary),
        remove,
      ),
      lineTwo,
      note,
    );
  }

  el.addEventListener("keydown", (e) => {
    if (e.target === el && e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      handlers.onOpen(card.key);
    }
  });
  if (!disabled) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      if (isEditing() || el.querySelector(".editor-wrap")) {
        e.preventDefault();
        return;
      }
      dragKey = card.key;
      e.dataTransfer?.setData("text/plain", card.key);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      // Style after the browser has captured the drag image.
      setTimeout(() => el.classList.add("card-dragging"), 0);
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("card-dragging");
      dragKey = null;
      for (const m of document.querySelectorAll<HTMLElement>(".board-drop")) m.hidden = true;
      for (const l of document.querySelectorAll(".board-lane-over")) l.classList.remove("board-lane-over");
      dragIdleListener?.();
    });
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      const here = locate(data, card.key);
      if (!here) return;
      if (!e.altKey) return;
      const colIdx = data.columns.indexOf(column);
      const len = (data.cards[column] ?? []).length;
      let op: BoardOp | null = null;
      if (e.key === "ArrowLeft" && colIdx > 0) {
        const dest = data.columns[colIdx - 1]!;
        op = { op: "move", key: card.key, column: dest, index: (data.cards[dest] ?? []).length };
      } else if (e.key === "ArrowRight" && colIdx < data.columns.length - 1) {
        const dest = data.columns[colIdx + 1]!;
        op = { op: "move", key: card.key, column: dest, index: (data.cards[dest] ?? []).length };
      } else if (e.key === "ArrowUp" && here.index > 0) {
        op = { op: "move", key: card.key, column, index: here.index - 1 };
      } else if (e.key === "ArrowDown" && here.index < len - 1) {
        op = { op: "move", key: card.key, column, index: here.index + 1 };
      }
      if (e.key.startsWith("Arrow")) e.preventDefault();
      if (op) handlers.onOp(op);
    });
  }
  return el;
}

/** Insertion index in the lane's list with the dragged card removed, from the cursor's Y position. */
function dropIndex(list: HTMLElement, clientY: number): { index: number; y: number } {
  const others = [...list.querySelectorAll<HTMLElement>(".board-card")].filter((c) => !c.classList.contains("card-dragging") && c.getAttribute("data-card-key") !== dragKey);
  const listTop = list.getBoundingClientRect().top;
  let index = 0;
  let y = 0;
  for (const c of others) {
    const r = c.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) {
      return { index, y: r.top - listTop };
    }
    index++;
    y = r.bottom - listTop;
  }
  return { index, y };
}

function laneEl(column: string, data: BoardResponse, handlers: BoardHandlers, disabled: boolean): HTMLElement {
  const cards = data.cards[column] ?? [];
  const list = h("div", { class: "board-cards" });
  const marker = h("div", { class: "board-drop" });
  marker.hidden = true;
  list.append(...cards.map((c) => cardEl(c, column, data, handlers, disabled)), marker);

  const head = h("div", { class: "board-lane-head" },
    h("h2", { class: "board-lane-name" }, column),
    h("span", { class: "board-count text-muted" }, String(cards.length)),
  );
  if (column === data.archiveColumn && cards.length > 0) {
    if (armed && armed.count !== cards.length) {
      clearTimeout(armed.timer);
      armed = null;
    }
    const btn = h("button", { type: "button", class: "btn board-archive" }, archiveLabel(cards.length, armed !== null));
    if (armed) btn.classList.add("board-archive-armed");
    if (disabled) btn.setAttribute("disabled", "");
    btn.addEventListener("click", () => {
      if (armed) {
        clearTimeout(armed.timer);
        const expected = armed.count;
        armed = null;
        if ((handlers.archiveCount?.() ?? expected) !== expected) {
          // the archive column changed since arming: ask again with the new count
          btn.textContent = archiveLabel(cards.length, false);
          btn.classList.remove("board-archive-armed");
          return;
        }
        handlers.onOp({ op: "archive" });
        return;
      }
      const count = cards.length;
      armed = {
        count,
        timer: setTimeout(() => {
          armed = null;
          if (archiveBtn) {
            archiveBtn.textContent = archiveLabel(count, false);
            archiveBtn.classList.remove("board-archive-armed");
          }
        }, ARCHIVE_CONFIRM_MS),
      };
      btn.textContent = archiveLabel(count, true);
      btn.classList.add("board-archive-armed");
    });
    archiveBtn = btn;
    head.append(btn);
  } else if (column === data.archiveColumn && armed) {
    clearTimeout(armed.timer);
    armed = null;
  }

  const lane = h("section", { class: "board-lane", "aria-label": column, tabindex: "-1" }, head, list);
  if (!disabled) {
    lane.addEventListener("dragover", (e) => {
      if (dragKey === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const { y } = dropIndex(list, e.clientY);
      marker.style.setProperty("top", `${y}px`);
      marker.hidden = false;
      lane.classList.add("board-lane-over");
    });
    lane.addEventListener("dragleave", (e) => {
      if (e.relatedTarget instanceof Node && lane.contains(e.relatedTarget)) return;
      marker.hidden = true;
      lane.classList.remove("board-lane-over");
    });
    lane.addEventListener("drop", (e) => {
      if (dragKey === null) return;
      e.preventDefault();
      const key = dragKey;
      const { index } = dropIndex(list, e.clientY);
      marker.hidden = true;
      lane.classList.remove("board-lane-over");
      const from = locate(data, key);
      if (!from || (from.column === column && from.index === index)) return;
      handlers.onOp({ op: "move", key, column, index });
    });
  }
  return lane;
}

interface FocusSpot {
  key: string;
  control: "card" | "title" | "x";
  lane: string | null;
  index: number;
}

function focusSpot(container: HTMLElement): FocusSpot | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !container.contains(active)) return null;
  const card = active.closest<HTMLElement>("[data-card-key]");
  if (!card) return null;
  const lane = card.closest<HTMLElement>(".board-lane");
  const siblings = lane ? [...lane.querySelectorAll<HTMLElement>("[data-card-key]")] : [];
  return {
    key: card.getAttribute("data-card-key")!,
    control: active === card ? "card" : active.classList.contains("card-x") ? "x" : active.classList.contains("card-key") ? "title" : "card",
    lane: lane?.getAttribute("aria-label") ?? null,
    index: siblings.indexOf(card),
  };
}

function restoreFocus(container: HTMLElement, spot: FocusSpot): void {
  const card = findCardEl(container, spot.key);
  if (card) {
    const target = spot.control === "card" ? card : card.querySelector<HTMLElement>(spot.control === "x" ? ".card-x" : ".card-key");
    (target && !target.hasAttribute("disabled") ? target : card).focus();
    return;
  }
  // The card is gone (removed or archived): focus its neighbour in the same lane, else the lane.
  const lane = [...container.querySelectorAll<HTMLElement>(".board-lane")].find((l) => l.getAttribute("aria-label") === spot.lane);
  if (!lane) return;
  const cards = [...lane.querySelectorAll<HTMLElement>("[data-card-key]")];
  (cards[Math.min(spot.index, cards.length - 1)] ?? lane).focus();
}

export function renderBoard(container: HTMLElement, data: BoardResponse, handlers: BoardHandlers): void {
  const disabled = data.locked;
  const spot = focusSpot(container);
  archiveBtn = null;

  const refresh = refreshButton(handlers.refreshing, disabled, () => handlers.onRefresh());
  const header = h("div", { class: "view-header board-header" },
    h("span", { class: "text-muted last-refreshed" }, `Last refreshed ${relativeTime(data.fetchedAt)}`),
    refresh,
  );
  const lanes = h("div", { class: "board-lanes" }, ...data.columns.map((c) => laneEl(c, data, handlers, disabled)));
  container.replaceChildren(header, lanes);

  if (spot) restoreFocus(container, spot);
}
