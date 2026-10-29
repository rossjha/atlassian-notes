import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilters, cellValue, sortRows } from "../src/shared/rowOps.ts";
import type { Row } from "../src/shared/types.ts";

function row(key: string, over: Partial<Row["ticket"]> = {}, custom: Record<string, string> = {}): Row {
  return {
    ticket: {
      id: key, key, url: "", summary: key, status: "To Do", statusCategory: "new", type: "Story",
      priority: null, assignee: null, reporter: null, storyPoints: null, parent: null, labels: [],
      sprint: null, updated: "2026-10-20T10:00:00Z", ...over,
    },
    note: null, groom: null, custom,
    flags: { jiraNewerThanNote: false, jiraNewerThanGroom: false },
  };
}
const keys = (rs: Row[]) => rs.map((r) => r.ticket.key);

test("oneOf keeps only matching rows; empty values is inactive", () => {
  const rows = [row("A-1", {}, { category: "bug" }), row("A-2", {}, { category: "feat" })];
  assert.deepEqual(keys(applyFilters(rows, { category: { op: "oneOf", values: ["bug"] } })), ["A-1"]);
  assert.deepEqual(keys(applyFilters(rows, { category: { op: "oneOf", values: [] } })), ["A-1", "A-2"]);
});

test("empty keeps rows with no value (missing or empty string)", () => {
  const rows = [row("A-1", {}, { category: "bug" }), row("A-2"), row("A-3", {}, { category: "" })];
  assert.deepEqual(keys(applyFilters(rows, { category: { op: "empty" } })), ["A-2", "A-3"]);
  assert.deepEqual(keys(applyFilters(rows, { category: { op: "notEmpty" } })), ["A-1"]);
});

test("contains is case-insensitive", () => {
  const rows = [row("A-1", {}, { remark: "Needs REFINEMENT" }), row("A-2", {}, { remark: "done" })];
  assert.deepEqual(keys(applyFilters(rows, { remark: { op: "contains", text: "refine" } })), ["A-1"]);
});

test("two filters combine with AND; builtin columns filter via cellValue", () => {
  const rows = [
    row("A-1", { status: "Done" }, { category: "bug" }),
    row("A-2", { status: "To Do" }, { category: "bug" }),
  ];
  const out = applyFilters(rows, {
    category: { op: "oneOf", values: ["bug"] },
    status: { op: "oneOf", values: ["Done"] },
  });
  assert.deepEqual(keys(out), ["A-1"]);
});

test("sorting keys naturally", () => {
  const rows = [row("PAY-10"), row("PAY-9"), row("PAY-100")];
  assert.deepEqual(keys(sortRows(rows, "key", "asc")), ["PAY-9", "PAY-10", "PAY-100"]);
  assert.deepEqual(keys(sortRows(rows, "key", "desc")), ["PAY-100", "PAY-10", "PAY-9"]);
  assert.deepEqual(keys(rows), ["PAY-10", "PAY-9", "PAY-100"]);
});

test("null storyPoints sort last in both directions; numbers numeric", () => {
  const rows = [row("A-1", { storyPoints: null }), row("A-2", { storyPoints: 10 }), row("A-3", { storyPoints: 2 })];
  assert.deepEqual(keys(sortRows(rows, "storyPoints", "asc")), ["A-3", "A-2", "A-1"]);
  assert.deepEqual(keys(sortRows(rows, "storyPoints", "desc")), ["A-2", "A-3", "A-1"]);
});

test("cellValue formats", () => {
  const r = row("A-1", { labels: ["x", "y"], components: ["API", "Web"], parent: { key: "E-1", summary: "e" }, storyPoints: 3 });
  r.groom = { readiness: "ready", summary: "ok", groomedAt: null };
  r.note = { body: "hi", mtimeMs: 0 };
  assert.equal(cellValue(r, "labels"), "x, y");
  assert.equal(cellValue(r, "components"), "API, Web");
  assert.equal(cellValue(row("A-2", {}), "components"), null);
  assert.equal(cellValue(r, "parent"), "E-1");
  assert.equal(cellValue(r, "storyPoints"), 3);
  assert.equal(cellValue(r, "groom"), "ready ok");
  assert.equal(cellValue(r, "note"), "hi");
  assert.equal(cellValue(r, "assignee"), null);
  assert.equal(cellValue(r, "nope"), null);
});

test("cellValue noteUpdated and groomed return epoch ms or null", () => {
  const bare = row("A-1");
  assert.equal(cellValue(bare, "noteUpdated"), null);
  assert.equal(cellValue(bare, "groomed"), null);
  const full: Row = {
    ...row("A-2"),
    note: { body: "x", mtimeMs: 1760000000000 },
    groom: { readiness: null, summary: "s", groomedAt: "2026-10-20T10:00:00Z" } as NonNullable<Row["groom"]>,
  };
  assert.equal(cellValue(full, "noteUpdated"), 1760000000000);
  assert.equal(cellValue(full, "groomed"), Date.parse("2026-10-20T10:00:00Z"));
  const bad: Row = { ...row("A-3"), groom: { readiness: null, summary: "s", groomedAt: "nope" } as NonNullable<Row["groom"]> };
  assert.equal(cellValue(bad, "groomed"), null);
  const nullDate: Row = { ...row("A-4"), groom: { readiness: null, summary: "s", groomedAt: null } as NonNullable<Row["groom"]> };
  assert.equal(cellValue(nullDate, "groomed"), null);
});

test("sortRows by noteUpdated desc puts newest first and no-note rows last", () => {
  const withNote = (key: string, mtimeMs: number): Row => ({ ...row(key), note: { body: "b", mtimeMs } });
  const rows = [row("A-1"), withNote("A-2", 1000), withNote("A-3", 3000), withNote("A-4", 2000)];
  assert.deepEqual(keys(sortRows(rows, "noteUpdated", "desc")), ["A-3", "A-4", "A-2", "A-1"]);
  assert.deepEqual(keys(sortRows(rows, "noteUpdated", "asc")), ["A-2", "A-4", "A-3", "A-1"]);
});

test("jira columns: cellValue, contains filter and sort read row.jira", () => {
  const a = { ...row("A-1"), jira: { release: "2.0" } };
  const b = { ...row("A-2"), jira: { release: "1.5" } };
  const c = row("A-3");
  assert.equal(cellValue(a, "release"), "2.0");
  assert.equal(cellValue(c, "release"), null);
  assert.deepEqual(keys(applyFilters([a, b, c], { release: { op: "contains", text: "1." } })), ["A-2"]);
  assert.deepEqual(keys(applyFilters([a, b, c], { release: { op: "empty" } })), ["A-3"]);
  assert.deepEqual(keys(sortRows([a, b, c], "release", "asc")), ["A-2", "A-1", "A-3"]);
});
