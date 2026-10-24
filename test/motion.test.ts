import { test } from "node:test";
import assert from "node:assert/strict";
import { tabNavDir } from "../src/web/motion.ts";

test("tabNavDir follows tab order: right is forward, left is back", () => {
  assert.equal(tabNavDir(0, 2), "forward");
  assert.equal(tabNavDir(3, 1), "back");
  assert.equal(tabNavDir(2, 0), "back");
});

test("tabNavDir is null for a re-selected, unknown or first tab", () => {
  assert.equal(tabNavDir(1, 1), null);
  assert.equal(tabNavDir(-1, 2), null);
  assert.equal(tabNavDir(2, -1), null);
});
