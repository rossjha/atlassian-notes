import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRow } from "../src/server/rows.ts";
import type { GroomFile, NoteFile, Ticket } from "../src/shared/types.ts";

const ticket: Ticket = {
  id: "1", key: "PAY-1", url: "https://x/browse/PAY-1", summary: "s", status: "To Do",
  statusCategory: "new", type: "Story", priority: null, assignee: null, reporter: null,
  storyPoints: null, parent: null, labels: [], sprint: null, updated: "2026-10-20T10:00:00.000Z",
};
const note = (mtimeMs: number, data: Record<string, unknown> = {}): NoteFile =>
  ({ key: "PAY-1", data, body: "my note", mtimeMs, parseError: null });

test("flags are true when updated is after note mtime and groomedAt", () => {
  const groom: GroomFile = {
    ...note(0), body: "g",
    summary: { readiness: "ready", summary: "ok", groomedAt: "2026-10-01T00:00:00Z" },
  };
  const r = buildRow(ticket, note(Date.parse("2026-10-01T00:00:00Z")), groom, []);
  assert.deepEqual(r.flags, { jiraNewerThanNote: true, jiraNewerThanGroom: true });
  assert.deepEqual(r.note, { body: "my note", mtimeMs: Date.parse("2026-10-01T00:00:00Z") });
  assert.equal(r.groom?.readiness, "ready");
  const r2 = buildRow(ticket, note(Date.parse("2026-11-01T00:00:00Z")), null, []);
  assert.deepEqual(r2.flags, { jiraNewerThanNote: false, jiraNewerThanGroom: false });
  assert.equal(r2.groom, null);
});

test("no note means no flags and null note", () => {
  const r = buildRow(ticket, null, null, ["category"]);
  assert.equal(r.note, null);
  assert.deepEqual(r.custom, {});
  assert.equal(r.flags.jiraNewerThanNote, false);
});

test("custom.category is read from note front matter; null/absent omitted", () => {
  const r = buildRow(ticket, note(0, { category: "bug", other: null, n: 3 }), null, ["category", "other", "missing", "n"]);
  assert.deepEqual(r.custom, { category: "bug", n: "3" });
});
