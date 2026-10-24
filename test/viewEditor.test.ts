import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueViewId } from "../src/web/viewEditor.ts";

test("slugify produces ids matching the server pattern", () => {
  assert.equal(slugify("Payments Team!"), "payments-team");
  assert.equal(slugify("  --Ünï  "), "n");
  assert.equal(slugify("***"), "view");
});

test("uniqueViewId appends -2, -3 when taken", () => {
  assert.equal(uniqueViewId("Payments", ["main"]), "payments");
  assert.equal(uniqueViewId("Payments", ["payments"]), "payments-2");
  assert.equal(uniqueViewId("Payments", ["payments", "payments-2"]), "payments-3");
});
