import { dropIndexToVisibleIndex } from "../shared/columnOps.ts";
import { h } from "./dom.ts";

/** Drag-to-reorder for the view tabs (Kanban stays fixed and isn't passed in). */

const DRAG_THRESHOLD_PX = 5;

let dragging = false;

/** True while a tab is being dragged; callers must not rebuild the tab bar under it. */
export function isTabDragging(): boolean {
  return dragging;
}

/** Swallows the click that follows a drag's pointerup so it doesn't select the tab. */
function suppressNextClick(): void {
  const stop = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

/**
 * Wires pointer dragging and Alt+Shift+←/→ onto the view tabs. `tabs[i]` is the tab-wrap of view `ids[i]`;
 * `onMove` gets the view id and its new index among the views. `onIdle` runs when a drag ends, for a
 * re-render that was held back meanwhile.
 */
export function attachTabDrag(
  tabs: HTMLElement[],
  ids: string[],
  onMove: (id: string, to: number) => void,
  onIdle: () => void,
): void {
  tabs.forEach((tab, i) => {
    tab.classList.add("tab-draggable");
    tab.addEventListener("pointerdown", (e) => startDrag(e, tabs, i, ids[i]!, onMove, onIdle));
    tab.addEventListener("keydown", (e) => {
      if (!e.altKey || !e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      const to = i + (e.key === "ArrowRight" ? 1 : -1);
      if (to >= 0 && to < tabs.length) onMove(ids[i]!, to);
    });
  });
}

function startDrag(
  e: PointerEvent,
  tabs: HTMLElement[],
  from: number,
  id: string,
  onMove: (id: string, to: number) => void,
  onIdle: () => void,
): void {
  if (e.button !== 0) return;
  const tab = tabs[from]!;
  const startX = e.clientX;
  const startY = e.clientY;
  let moving = false;
  let cancelled = false;
  let gap = from;
  let marker: HTMLElement | null = null;

  const placeMarker = (x: number): void => {
    gap = tabs.filter((t) => {
      const r = t.getBoundingClientRect();
      return (r.left + r.right) / 2 < x;
    }).length;
    const edge = gap < tabs.length ? tabs[gap]!.getBoundingClientRect().left : tabs[tabs.length - 1]!.getBoundingClientRect().right;
    const r = tab.getBoundingClientRect();
    marker!.style.setProperty("left", `${Math.round(edge) - 1}px`);
    marker!.style.setProperty("top", `${Math.round(r.top)}px`);
    marker!.style.setProperty("height", `${Math.round(r.height)}px`);
  };
  const clearVisuals = (): void => {
    marker?.remove();
    marker = null;
    tab.classList.remove("tab-moving");
    document.documentElement.classList.remove("tabs-dragging");
  };
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onCancel);
    document.removeEventListener("keydown", onKey, true);
    clearVisuals();
    if (!moving) return; // a plain click: let it select the tab
    dragging = false;
    const to = dropIndexToVisibleIndex(from, gap);
    if (commit && !cancelled && tab.isConnected && to !== from) onMove(id, to);
    else onIdle();
  };
  const onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    if (ev.buttons === 0) return finish(false); // the release happened somewhere we didn't see
    if (cancelled) return;
    if (!moving) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      moving = true;
      dragging = true;
      tab.classList.add("tab-moving");
      document.documentElement.classList.add("tabs-dragging");
      marker = h("div", { class: "col-drop-marker", "aria-hidden": "true" });
      document.body.append(marker);
    }
    placeMarker(ev.clientX);
  };
  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    if (moving) suppressNextClick();
    finish(true);
  };
  const onCancel = (ev: Event): void => {
    if (ev instanceof PointerEvent && ev.pointerId !== e.pointerId) return;
    finish(false);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || !moving) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelled = true; // keep listening until pointerup so its click is swallowed
    clearVisuals();
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onCancel);
  document.addEventListener("keydown", onKey, true);
}
