import { test } from "node:test";
import assert from "node:assert/strict";
import { moveById } from "../src/shared/order.ts";

const items = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (xs: { id: string }[]): string => xs.map((x) => x.id).join("");

test("moveById moves right and left", () => {
  assert.equal(ids(moveById(items, "a", 2)), "bcad");
  assert.equal(ids(moveById(items, "d", 0)), "dabc");
  assert.equal(ids(moveById(items, "b", 3)), "acdb");
});

test("moveById clamps the target and leaves the input untouched", () => {
  assert.equal(ids(moveById(items, "a", 99)), "bcda");
  assert.equal(ids(moveById(items, "c", -5)), "cabd");
  assert.equal(ids(items), "abcd");
});

test("moveById returns the same array for no-ops and unknown ids", () => {
  assert.equal(moveById(items, "b", 1), items);
  assert.equal(moveById(items, "zz", 0), items);
});
