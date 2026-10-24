import type { ColumnSetting } from "./types.ts";

export const MIN_COLUMN_WIDTH = 48;
/** Narrow columns (key, points) may be dragged a little tighter. */
export const MIN_NARROW_COLUMN_WIDTH = 40;
export const MAX_COLUMN_WIDTH = 1200;
const NARROW = new Set(["key", "storyPoints"]);

/** Whole px within the drag limits for this column. */
export function clampColumnWidth(columnId: string, px: number): number {
  const min = NARROW.has(columnId) ? MIN_NARROW_COLUMN_WIDTH : MIN_COLUMN_WIDTH;
  return Math.min(MAX_COLUMN_WIDTH, Math.max(min, Math.round(px)));
}

/** A copy with that column's width set (null removes it = automatic width). */
export function setColumnWidth(columns: ColumnSetting[], id: string, width: number | null): ColumnSetting[] {
  return columns.map((c) => {
    if (c.id !== id) return c;
    const { width: _old, ...rest } = c;
    return width === null ? rest : { ...rest, width };
  });
}

/**
 * Converts a drop gap (0 = before the first visible column, n = after the last) into the visible
 * index the dragged column ends up at, given where it started.
 */
export function dropIndexToVisibleIndex(fromVisibleIndex: number, gap: number): number {
  return gap > fromVisibleIndex ? gap - 1 : gap;
}

/**
 * Moves a visible column so it ends up at `toVisibleIndex` among the visible columns.
 * Hidden columns keep their place: a column moved right lands just after its new left neighbour,
 * one moved left just before its new right neighbour. Returns the input array when nothing changes.
 */
export function moveColumn(columns: ColumnSetting[], fromId: string, toVisibleIndex: number): ColumnSetting[] {
  const visible = columns.filter((c) => !c.hidden);
  const from = visible.findIndex((c) => c.id === fromId);
  if (from < 0) return columns;
  const to = Math.max(0, Math.min(visible.length - 1, Math.trunc(toVisibleIndex)));
  if (to === from) return columns;
  const moving = visible[from]!;
  const rest = columns.filter((c) => c !== moving);
  const others = visible.filter((c) => c !== moving);
  const at = to > from ? rest.indexOf(others[to - 1]!) + 1 : rest.indexOf(others[to]!);
  rest.splice(at, 0, moving);
  return rest;
}
