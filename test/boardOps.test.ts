import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOpLocal, shouldAutoMove } from "../src/shared/boardOps.ts";
import { applyBoardOp } from "../src/server/board.ts";
import type { BoardFile, BoardOp, BoardResponse } from "../src/shared/types.ts";

const file: BoardFile = { columns: ["A", "B"], archiveColumn: "B", noteColumn: "A", cards: { A: ["X-1", "X-2", "X-3"], B: ["X-4", "X-5"] } };
const resp: BoardResponse = {
  columns: file.columns,
  archiveColumn: "B",
  noteColumn: "A",
  cards: Object.fromEntries(Object.entries(file.cards).map(([c, ks]) => [c, ks.map((key) => ({ key, row: null, missing: false }))])),
  fetchedAt: null,
  error: null,
  locked: false,
};
const keys = (r: BoardResponse) => Object.fromEntries(Object.entries(r.cards).map(([c, cs]) => [c, cs.map((x) => x.key)]));

test("applyOpLocal matches the server for move/remove/archive", () => {
  const ops: BoardOp[] = [
    { op: "move", key: "X-1", column: "A", index: 1 }, // same lane, index is in the list without X-1
    { op: "move", key: "X-3", column: "A", index: 0 },
    { op: "move", key: "X-1", column: "A", index: 2 }, // to the end
    { op: "move", key: "X-2", column: "B", index: 1 }, // cross lane
    { op: "move", key: "X-2", column: "B", index: 99 }, // clamped high
    { op: "move", key: "X-2", column: "B", index: -5 }, // clamped low
    { op: "remove", key: "X-4" },
    { op: "remove", key: "X-9" },
    { op: "archive" },
  ];
  for (const op of ops) {
    assert.deepEqual(keys(applyOpLocal(resp, op)), applyBoardOp(file, op).cards, JSON.stringify(op));
  }
});

test("applyOpLocal leaves add to the server and does not mutate its input", () => {
  const before = JSON.stringify(resp);
  assert.deepEqual(keys(applyOpLocal(resp, { op: "add", key: "X-9" })), file.cards);
  applyOpLocal(resp, { op: "move", key: "X-1", column: "B", index: 0 });
  applyOpLocal(resp, { op: "archive" });
  assert.equal(JSON.stringify(resp), before);
});

test("applyOpLocal clamps an index of MAX_SAFE_INTEGER to the end, like the server", () => {
  const op: BoardOp = { op: "move", key: "X-1", column: "B", index: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(keys(applyOpLocal(resp, op)).B, ["X-4", "X-5", "X-1"]);
  assert.deepEqual(applyBoardOp(file, op).cards.B, ["X-4", "X-5", "X-1"]);
});

test("shouldAutoMove: only a search-opened, non-empty note for an off-board ticket on a ready, unlocked board with a note column", () => {
  const base = { openedFromSearch: true, onBoard: false, ready: true, locked: false, body: "hi", noteColumn: "Doing" as string | undefined };
  assert.equal(shouldAutoMove(base), true);
  assert.equal(shouldAutoMove({ ...base, openedFromSearch: false }), false);
  assert.equal(shouldAutoMove({ ...base, onBoard: true }), false);
  assert.equal(shouldAutoMove({ ...base, ready: false }), false);
  assert.equal(shouldAutoMove({ ...base, locked: true }), false);
  assert.equal(shouldAutoMove({ ...base, body: "  \n" }), false);
  assert.equal(shouldAutoMove({ ...base, noteColumn: undefined }), false);
});
