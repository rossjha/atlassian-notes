import { clampColumnWidth, dropIndexToVisibleIndex, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "../shared/columnOps.ts";
import type { ColumnSetting } from "../shared/types.ts";
import { h } from "./dom.ts";

/** Column resize (header edge handle) and reorder (header drag) for the ticket table. */
export interface ColumnControls {
  /** null = back to automatic width. Called once per gesture, never per pointer move. */
  onResize(columnId: string, width: number | null): void;
  onMove(columnId: string, toVisibleIndex: number): void;
}

const DRAG_THRESHOLD_PX = 5;
const KEY_STEP_PX = 16;

let active = 0;
let idleListener: (() => void) | null = null;
/** Column whose resize handle gets focus back after the re-render a keyboard resize causes. */
let refocusId: string | null = null;

/** True while a column is being resized or dragged; callers must not rebuild the table under it. */
export function isColumnDragging(): boolean {
  return active > 0;
}

/** Called when a resize/drag gesture ends (used to apply deferred re-renders). */
export function onColumnDragIdle(cb: () => void): void {
  idleListener = cb;
}

function begin(): () => void {
  active++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active--;
    if (active === 0) idleListener?.();
  };
}

/** Sets or clears an explicit width on a column's cells (CSS: .col-sized uses --col-w). */
export function applyColumnWidth(cells: Iterable<HTMLElement>, width: number | null | undefined): void {
  for (const cell of cells) {
    if (width == null) {
      cell.classList.remove("col-sized");
      cell.style.removeProperty("--col-w");
    } else {
      cell.classList.add("col-sized");
      cell.style.setProperty("--col-w", `${width}px`);
    }
  }
}

function columnCells(table: HTMLTableElement, index: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const row of table.rows) {
    const cell = row.cells[index];
    if (cell) out.push(cell);
  }
  return out;
}

/** Swallows the click that follows a drag's pointerup so it doesn't sort or toggle. */
function suppressNextClick(): void {
  const stop = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

/**
 * Wires resize handles and header dragging onto a rendered table. `offset` is the number of fixed
 * leading cells (the ★ column), which never move and are not resizable. Call after the table is in the DOM.
 */
export function attachColumnControls(
  table: HTMLTableElement,
  visible: ColumnSetting[],
  offset: number,
  labelOf: (id: string) => string,
  ctl: ColumnControls,
): void {
  const headRow = table.tHead?.rows[0];
  if (!headRow) return;
  const ths = visible.map((_, i) => headRow.cells[offset + i]!);
  ths.forEach((th, i) => {
    const c = visible[i]!;
    th.append(resizeHandle(table, th, c, offset + i, labelOf(c.id), ctl));
    th.classList.add("th-draggable");
    th.addEventListener("pointerdown", (e) => startMove(e, table, ths, i, c, ctl));
  });
  if (refocusId !== null) {
    const i = visible.findIndex((c) => c.id === refocusId);
    refocusId = null;
    if (i >= 0) ths[i]!.querySelector<HTMLElement>(".th-resize")?.focus();
  }
}

function resizeHandle(
  table: HTMLTableElement,
  th: HTMLTableCellElement,
  c: ColumnSetting,
  index: number,
  label: string,
  ctl: ColumnControls,
): HTMLElement {
  const handle = h("span", {
    class: "th-resize",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": `Resize ${label} column`,
    "aria-valuemin": String(clampColumnWidth(c.id, 0)),
    "aria-valuemax": String(MAX_COLUMN_WIDTH),
    title: "Drag to resize; double-click for automatic width",
  });
  const setNow = (w: number): void => handle.setAttribute("aria-valuenow", String(Math.round(w)));
  setNow(c.width ?? MIN_COLUMN_WIDTH);
  handle.addEventListener("focus", () => setNow(c.width ?? th.getBoundingClientRect().width));
  handle.addEventListener("click", (e) => e.stopPropagation());
  handle.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (c.width !== undefined) ctl.onResize(c.id, null);
  });

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cells = columnCells(table, index);
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    let width = clampColumnWidth(c.id, startW);
    let moved = false;
    const end = begin();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("active");
    document.documentElement.classList.add("cols-resizing");
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      if (ev.clientX !== startX) moved = true;
      if (!moved) return;
      width = clampColumnWidth(c.id, startW + ev.clientX - startX);
      applyColumnWidth(cells, width);
      setNow(width);
    };
    const finish = (commit: boolean): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey, true);
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("active");
      document.documentElement.classList.remove("cols-resizing");
      if (!commit || !moved) applyColumnWidth(cells, c.width);
      end(); // before the commit, so the commit's re-render isn't deferred
      if (commit && moved && width !== c.width) ctl.onResize(c.id, width);
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId === e.pointerId) finish(true);
    };
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId === e.pointerId) finish(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey, true);
  });

  // Keyboard: ←/→ resize live; the width is saved on keyup (or blur).
  let kbWidth: number | null = null;
  let kbEnd: (() => void) | null = null;
  const commitKeyboard = (refocus: boolean): void => {
    if (kbWidth === null) return;
    const w = kbWidth;
    kbWidth = null;
    const end = kbEnd;
    kbEnd = null;
    end?.();
    if (w !== c.width) {
      if (refocus) refocusId = c.id;
      ctl.onResize(c.id, w);
    }
  };
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    kbEnd ??= begin();
    const base = kbWidth ?? th.getBoundingClientRect().width;
    kbWidth = clampColumnWidth(c.id, base + (e.key === "ArrowRight" ? KEY_STEP_PX : -KEY_STEP_PX));
    applyColumnWidth(columnCells(table, index), kbWidth);
    setNow(kbWidth);
  });
  handle.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") commitKeyboard(true);
  });
  handle.addEventListener("blur", () => commitKeyboard(false));
  return handle;
}

function startMove(
  e: PointerEvent,
  table: HTMLTableElement,
  ths: HTMLTableCellElement[],
  from: number,
  c: ColumnSetting,
  ctl: ColumnControls,
): void {
  if (e.button !== 0 || (e.target as Element).closest(".th-resize")) return;
  const th = ths[from]!;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let cancelled = false;
  let gap = from;
  let end: (() => void) | null = null;
  let marker: HTMLElement | null = null;

  const placeMarker = (x: number): void => {
    gap = ths.filter((t) => {
      const r = t.getBoundingClientRect();
      return (r.left + r.right) / 2 < x;
    }).length;
    const edge = gap < ths.length ? ths[gap]!.getBoundingClientRect().left : ths[ths.length - 1]!.getBoundingClientRect().right;
    const tr = table.getBoundingClientRect();
    const top = Math.max(0, tr.top);
    const bottom = Math.min(window.innerHeight, tr.bottom);
    marker!.style.setProperty("left", `${Math.round(edge) - 1}px`);
    marker!.style.setProperty("top", `${Math.round(top)}px`);
    marker!.style.setProperty("height", `${Math.max(0, Math.round(bottom - top))}px`);
  };
  const clearVisuals = (): void => {
    marker?.remove();
    marker = null;
    th.classList.remove("th-moving");
    document.documentElement.classList.remove("cols-dragging");
  };
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId || cancelled) return;
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      end = begin();
      th.setPointerCapture(e.pointerId);
      th.classList.add("th-moving");
      document.documentElement.classList.add("cols-dragging");
      marker = h("div", { class: "col-drop-marker", "aria-hidden": "true" });
      document.body.append(marker);
    }
    placeMarker(ev.clientX);
  };
  const cleanup = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onKey, true);
    if (th.hasPointerCapture(e.pointerId)) th.releasePointerCapture(e.pointerId);
    clearVisuals();
  };
  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    cleanup();
    if (!dragging) return; // a plain click: let it sort
    suppressNextClick();
    end?.();
    if (cancelled) return;
    const to = dropIndexToVisibleIndex(from, gap);
    if (to !== from) ctl.onMove(c.id, to);
  };
  const onCancel = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    cleanup();
    end?.();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelled = true; // keep listening until pointerup so its click is swallowed
    clearVisuals();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  document.addEventListener("keydown", onKey, true);
}
