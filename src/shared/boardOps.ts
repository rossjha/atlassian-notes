import type { BoardCard, BoardOp, BoardResponse } from "./types.ts";

export function locate(data: BoardResponse, key: string): { column: string; index: number } | null {
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
      const target = dest; // dest is the same array as the source list when the column is unchanged
      target.splice(Math.max(0, Math.min(op.index, target.length)), 0, card!);
      break;
    }
  }
  return { ...data, cards };
}

