import type { BoardCard, BoardOp, BoardResponse, Row } from "../shared/types.ts";
import { h, relativeTime } from "./dom.ts";
import { editNote, isEditing } from "./editors.ts";

export interface BoardHandlers {
  onOpen(key: string): void;
  onOp(op: BoardOp): void;
  onNoteSaved(): void;
  onRefresh(): void;
  refreshing: boolean;
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

function locate(data: BoardResponse, key: string): { column: string; index: number } | null {
  for (const column of data.columns) {
    const index = (data.cards[column] ?? []).findIndex((c) => c.key === key);
    if (index >= 0) return { column, index };
  }
  return null;
}

/**
 * Applies an operation to a board snapshot the way the server will (used for optimistic updates).
 * `move.index` is a position in the destination list without the moved key.
 */
export function applyOpLocal(data: BoardResponse, op: BoardOp): BoardResponse {
  const cards: Record<string, BoardCard[]> = {};
  for (const c of data.columns) cards[c] = [...(data.cards[c] ?? [])];
  switch (op.op) {
    case "add":
      break; // needs ticket data; the server response supplies it
    case "remove":
      for (const c of data.columns) cards[c] = cards[c]!.filter((x) => x.key !== op.key);
      break;
    case "archive":
      cards[data.archiveColumn] = [];
      break;
    case "move": {
      const from = locate(data, op.key);
      const dest = cards[op.column];
      if (!from || !dest) break;
      const [card] = cards[from.column]!.splice(from.index, 1);
      const target = from.column === op.column ? cards[from.column]! : dest;
      target.splice(Math.max(0, Math.min(op.index, target.length)), 0, card!);
      break;
    }
  }
  return { ...data, cards };
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
  const el = h("article", { class: "board-card", tabindex: "0", "data-card-key": card.key, "aria-label": card.row ? `${card.key} ${card.row.ticket.summary}` : card.key });
  const remove = h("button", {
    type: "button",
    class: "card-x",
    title: "Take off my board",
    "aria-label": `Remove ${card.key} from my board`,
    onclick: () => handlers.onOp({ op: "remove", key: card.key }),
  }, "✕");
  if (disabled) remove.setAttribute("disabled", "");

  const row: Row | null = card.row;
  if (!row) {
    el.classList.add("card-empty");
    el.append(
      h("div", { class: "card-line" }, h("span", { class: "key" }, card.key), remove),
      h("div", { class: "text-muted" }, card.missing ? "not found in Jira" : "loading…"),
    );
  } else {
    const t = row.ticket;
    const lineTwo = h("div", { class: "card-line card-meta" },
      h("span", { class: `pill cat-${t.statusCategory.replace(/\W+/g, "-").toLowerCase()}` }, t.status),
      row.groom?.readiness ? h("span", { class: "pill groom-readiness" }, row.groom.readiness) : null,
      row.flags.jiraNewerThanNote ? h("span", { class: "stale-dot card-stale", title: "Jira changed after this note was last edited" }) : null,
    );
    const note = h("div", { class: `card-note${row.note?.body ? "" : " card-note-empty"}` }, row.note?.body ? row.note.body : "+ add note");
    if (!disabled) {
      note.addEventListener("click", () => {
        if (note.querySelector(".editor-wrap")) return;
        el.draggable = false; // a textarea inside a draggable card can't select text in Firefox
        note.classList.add("card-note-editing");
        editNote(note, row, () => handlers.onNoteSaved(), { rows: 4 });
      });
    }
    el.append(
      h("div", { class: "card-line" },
        h("span", { class: "key" }, t.key),
        h("button", { type: "button", class: "card-title", onclick: () => handlers.onOpen(t.key) }, t.summary),
        remove,
      ),
      lineTwo,
      note,
    );
  }

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
      for (const m of document.querySelectorAll(".board-drop")) m.remove();
      dragIdleListener?.();
    });
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      const here = locate(data, card.key);
      if (!here) return;
      if (e.key === "Enter" && !e.altKey) {
        e.preventDefault();
        handlers.onOpen(card.key);
        return;
      }
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
    if (armed) btn.classList.add("armed");
    if (disabled) btn.setAttribute("disabled", "");
    btn.addEventListener("click", () => {
      if (armed) {
        clearTimeout(armed.timer);
        armed = null;
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
            archiveBtn.classList.remove("armed");
          }
        }, ARCHIVE_CONFIRM_MS),
      };
      btn.textContent = archiveLabel(count, true);
      btn.classList.add("armed");
    });
    archiveBtn = btn;
    head.append(btn);
  } else if (column === data.archiveColumn && armed) {
    clearTimeout(armed.timer);
    armed = null;
  }

  const lane = h("section", { class: "board-lane", "aria-label": column }, head, list);
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

export function renderBoard(container: HTMLElement, data: BoardResponse, handlers: BoardHandlers): void {
  const disabled = data.locked;
  const focusedKey = container.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).closest("[data-card-key]")?.getAttribute("data-card-key") ?? null
    : null;
  archiveBtn = null;

  const refresh = h("button", { type: "button", class: "btn", onclick: () => handlers.onRefresh() }, handlers.refreshing ? "Refreshing…" : "Refresh");
  if (handlers.refreshing || disabled) refresh.setAttribute("disabled", "");
  const header = h("div", { class: "view-header board-header" },
    h("span", { class: "text-muted last-refreshed" }, `Last refreshed ${relativeTime(data.fetchedAt)}`),
    refresh,
  );
  const lanes = h("div", { class: "board-lanes" }, ...data.columns.map((c) => laneEl(c, data, handlers, disabled)));
  container.replaceChildren(header, lanes);

  if (focusedKey) findCardEl(container, focusedKey)?.focus();
}
