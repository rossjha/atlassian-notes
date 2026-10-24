import { test } from "node:test";
import assert from "node:assert/strict";
import { clampColumnWidth, dropIndexToVisibleIndex, moveColumn, setColumnWidth } from "../src/shared/columnOps.ts";
import type { ColumnSetting } from "../src/shared/types.ts";

const ids = (cs: ColumnSetting[]): string => cs.map((c) => (c.hidden ? `(${c.id})` : c.id)).join(" ");

const cols: ColumnSetting[] = [
  { id: "a" },
  { id: "h1", hidden: true },
  { id: "b" },
  { id: "c", width: 100 },
  { id: "h2", hidden: true },
  { id: "d" },
];

test("moveColumn moves to a visible position, hidden columns keep their place", () => {
  assert.equal(ids(moveColumn(cols, "a", 2)), "(h1) b c a (h2) d");
  assert.equal(ids(moveColumn(cols, "d", 0)), "d a (h1) b c (h2)");
  assert.equal(ids(moveColumn(cols, "b", 3)), "a (h1) c (h2) d b");
  assert.equal(ids(moveColumn(cols, "c", 1)), "a (h1) c b (h2) d");
});

test("moveColumn keeps settings, clamps the index, and is a no-op for unknown ids or same place", () => {
  const moved = moveColumn(cols, "c", 99);
  assert.equal(ids(moved), "a (h1) b (h2) d c");
  assert.deepEqual(moved.at(-1), { id: "c", width: 100 });
  assert.equal(ids(moveColumn(cols, "c", -5)), "c a (h1) b (h2) d");
  assert.equal(moveColumn(cols, "zzz", 0), cols);
  assert.equal(moveColumn(cols, "b", 1), cols);
  assert.equal(moveColumn(cols, "h1", 0), cols);
  assert.equal(ids(cols), "a (h1) b c (h2) d"); // input untouched
});

test("dropIndexToVisibleIndex converts a gap (0..n) into the final visible index", () => {
  assert.equal(dropIndexToVisibleIndex(0, 4), 3);
  assert.equal(dropIndexToVisibleIndex(0, 1), 0);
  assert.equal(dropIndexToVisibleIndex(3, 0), 0);
  assert.equal(dropIndexToVisibleIndex(3, 3), 3);
  assert.equal(dropIndexToVisibleIndex(3, 4), 3);
  assert.equal(dropIndexToVisibleIndex(1, 3), 2);
});

test("clampColumnWidth rounds and clamps; narrow columns may go to 40px", () => {
  assert.equal(clampColumnWidth("summary", 10), 48);
  assert.equal(clampColumnWidth("key", 10), 40);
  assert.equal(clampColumnWidth("storyPoints", 41.4), 41);
  assert.equal(clampColumnWidth("summary", 5000), 1200);
  assert.equal(clampColumnWidth("summary", 300.5), 301);
});

test("setColumnWidth sets or removes width for one column only", () => {
  const w = setColumnWidth(cols, "a", 250);
  assert.deepEqual(w[0], { id: "a", width: 250 });
  assert.equal(w[2], cols[2]);
  const r = setColumnWidth(cols, "c", null);
  assert.deepEqual(r[3], { id: "c" });
  assert.deepEqual(cols[3], { id: "c", width: 100 });
});
