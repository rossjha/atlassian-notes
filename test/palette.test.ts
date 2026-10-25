import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPalette, matchScore, type PaletteCommand } from "../src/shared/palette.ts";

const run = () => {};
const cmd = (id: string, label: string, group: string, keywords: string[] = []): PaletteCommand => ({ id, label, group, keywords, run });

const commands = [
  cmd("kanban", "Kanban", "Go to"),
  cmd("scratch", "Scratchpad", "Go to"),
  cmd("view-backlog", "Backlog", "Go to", ["view", "tab"]),
  cmd("refresh", "Refresh from Jira", "View"),
  cmd("theme-carbon", "Carbon", "Theme"),
  cmd("theme-nord", "Nord", "Theme"),
];
const shape = (gs: ReturnType<typeof filterPalette>) => gs.map((g) => [g.heading, g.items.map((c) => c.id)]);

test("an empty query lists every group and command in the order given", () => {
  assert.deepEqual(shape(filterPalette(commands, "  ")), [
    ["Go to", ["kanban", "scratch", "view-backlog"]],
    ["View", ["refresh"]],
    ["Theme", ["theme-carbon", "theme-nord"]],
  ]);
});

test("typing a group name finds that group's commands (headings are searchable)", () => {
  assert.deepEqual(shape(filterPalette(commands, "theme")), [["Theme", ["theme-carbon", "theme-nord"]]]);
});

test("groups with no matches are hidden", () => {
  assert.deepEqual(shape(filterPalette(commands, "nord")), [["Theme", ["theme-nord"]]]);
  assert.deepEqual(filterPalette(commands, "zzz"), []);
});

test("every word must match somewhere, in any order", () => {
  assert.deepEqual(shape(filterPalette(commands, "theme car")), [["Theme", ["theme-carbon"]]]);
  assert.deepEqual(shape(filterPalette(commands, "car theme")), [["Theme", ["theme-carbon"]]]);
  assert.deepEqual(filterPalette(commands, "theme kanban"), []);
});

test("keywords match but don't show", () => {
  assert.deepEqual(shape(filterPalette(commands, "tab")), [["Go to", ["view-backlog"]]]);
});

test("matching is case-insensitive", () => {
  assert.deepEqual(shape(filterPalette(commands, "JIRA")), [["View", ["refresh"]]]);
});

test("a label that starts with the query beats one that only contains it, and its group moves up", () => {
  const cs = [cmd("a", "Open in Jira", "View"), cmd("b", "Jira board", "Links")];
  assert.deepEqual(shape(filterPalette(cs, "jira")), [["Links", ["b"]], ["View", ["a"]]]);
});

test("within a group, better matches come first; ties keep their order", () => {
  const cs = [cmd("a", "Edit view", "View"), cmd("b", "View in Jira", "View"), cmd("c", "Delete view", "View")];
  assert.deepEqual(shape(filterPalette(cs, "view")), [["View", ["b", "a", "c"]]]);
});

test("matchScore ranks label prefix > word start > substring > group or keyword only", () => {
  const c = cmd("x", "Refresh from Jira", "View", ["reload"]);
  const prefix = matchScore(c, ["ref"]);
  const word = matchScore(c, ["jir"]);
  const sub = matchScore(c, ["fres"]);
  const other = matchScore(c, ["reload"]);
  assert.ok(prefix > word && word > sub && sub > other && other > 0, `${prefix} ${word} ${sub} ${other}`);
  assert.equal(matchScore(c, ["nope"]), 0);
});
