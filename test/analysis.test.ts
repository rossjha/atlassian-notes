import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attention, blockedReasons, categoryOf, chartsFor, complete, componentMatches, DEFAULT_SETTINGS, drillRows,
  isMoving, isStalled, parseAnalysisConfig, perPerson, split, sprintOf, sprintPosition, valuesOf,
  type AnalysisConfig, type AnalysisSettings,
} from "../src/shared/analysis.ts";
import type { Row, Ticket } from "../src/shared/types.ts";

const NOW = new Date(2026, 9, 29, 12); // Thu 29 Oct 2026, local
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(key: string, over: Partial<Ticket> = {}, custom: Record<string, string> = {}): Row {
  return {
    ticket: {
      id: key, key, url: "", summary: key, status: "To Do", statusCategory: "To Do", statusCategoryKey: "new",
      type: "Story", priority: null, assignee: null, reporter: null, storyPoints: null, parent: null, labels: [],
      sprint: null, components: [], updated: daysAgo(0), ...over,
    },
    note: null, groom: null, custom,
    flags: { jiraNewerThanNote: false, jiraNewerThanGroom: false },
  };
}
const ip = { status: "In Progress", statusCategory: "In Progress", statusCategoryKey: "indeterminate" as const };
const done = { status: "Done", statusCategory: "Done", statusCategoryKey: "done" as const };

const cfg: AnalysisConfig = parseAnalysisConfig({
  groups: {
    product: { Payments: ["pay-api", "pay UI"], Notifications: ["notify-*"] },
    layer: { Frontend: ["* UI"], Backend: ["*-api"] },
  },
});
const S: AnalysisSettings = { ...DEFAULT_SETTINGS, blocked: { statuses: ["Blocked"], flagField: "customfield_00000", links: true } };

test("categoryOf uses the key, else the category name", () => {
  assert.equal(categoryOf(row("A-1").ticket), "todo");
  assert.equal(categoryOf(row("A-1", done).ticket), "done");
  assert.equal(categoryOf(row("A-1", ip).ticket), "inProgress");
  const legacy = row("A-1", { statusCategory: "Done", statusCategoryKey: undefined }).ticket;
  assert.equal(categoryOf(legacy), "done");
  assert.equal(categoryOf(row("A-1", { statusCategory: "To Do", statusCategoryKey: undefined }).ticket), "todo");
  assert.equal(categoryOf(row("A-1", { statusCategory: "In Progress", statusCategoryKey: undefined }).ticket), "inProgress");
});

test("parseAnalysisConfig: missing file gives defaults", () => {
  const c = parseAnalysisConfig(null);
  assert.deepEqual(c.settings, DEFAULT_SETTINGS);
  assert.deepEqual(c.groups, {});
  assert.deepEqual(c.views, {});
});

test("parseAnalysisConfig: settings, per-view merge, fields/flagField global only", () => {
  const c = parseAnalysisConfig({
    settings: { measure: "tickets", stalledDays: 5, freeze: "W2/D3", blocked: { statuses: ["Blocked"], flagField: "customfield_00001" }, fields: ["customfield_00002"] },
    views: { current: { settings: { lowLoad: 5, fields: ["customfield_99999"], blocked: { links: false } }, charts: ["headlines", { type: "bars", by: "group:product", title: "Products" }] } },
    groups: { product: { A: ["x"] } },
  });
  assert.equal(c.settings.measure, "tickets");
  assert.deepEqual(c.settings.freeze, { week: 2, day: 3 });
  const v = c.views.current!;
  assert.equal(v.settings.lowLoad, 5);
  assert.equal(v.settings.stalledDays, 5);
  assert.deepEqual(v.settings.fields, ["customfield_00002"]);
  assert.equal(v.settings.blocked.flagField, "customfield_00001");
  assert.equal(v.settings.blocked.links, false);
  assert.deepEqual(v.settings.blocked.statuses, ["Blocked"]);
  assert.deepEqual(v.charts, [{ type: "headlines" }, { type: "bars", by: "group:product", title: "Products" }]);
});

test("parseAnalysisConfig rejects bad input with a readable message", () => {
  assert.throws(() => parseAnalysisConfig({ views: { v: { charts: ["pie"] } } }), /unknown chart type "pie"/);
  assert.throws(() => parseAnalysisConfig({ views: { v: { charts: [{ type: "bars" }] } } }), /needs `by`/);
  assert.throws(() => parseAnalysisConfig({ views: { v: { charts: [{ type: "bars", by: "group:nope" }] } } }), /unknown group set "nope"/);
  assert.throws(() => parseAnalysisConfig({ views: { v: { charts: [{ type: "bars", by: "colour" }] } } }), /`by`/);
  assert.throws(() => parseAnalysisConfig({ settings: { freeze: "W3/D9" } }), /freeze/);
  assert.throws(() => parseAnalysisConfig({ settings: { measure: "hours" } }), /measure/);
  assert.throws(() => parseAnalysisConfig({ groups: { product: { A: "x" } } }), /list of component/);
  assert.throws(() => parseAnalysisConfig("nope"), /mapping/);
});

test("chartsFor: defaults for unknown views, countdown only with a sprint", () => {
  const d = chartsFor(null, "x", true).charts.map((c) => c.type);
  assert.deepEqual(d, ["countdown", "headlines", "progress", "perPerson", "attention", "bars"]);
  assert.equal(chartsFor(null, "x", false).charts[0]!.type, "headlines");
  const c = parseAnalysisConfig({ views: { v: { charts: ["complete"] } } });
  assert.deepEqual(chartsFor(c, "v", true).charts, [{ type: "complete" }]);
});

test("componentMatches: wildcard and case", () => {
  assert.ok(componentMatches("* UI", "Pay UI"));
  assert.ok(componentMatches("notify-*", "Notify-API"));
  assert.ok(componentMatches("infra", "INFRA"));
  assert.ok(!componentMatches("infra", "infra-2"));
  assert.ok(!componentMatches("a.b", "axb"));
});

test("valuesOf: groups overlap, Other, (none), Unassigned, columns, fields", () => {
  const r = row("A-1", { components: ["pay UI", "notify-api"], assignee: "Sam", labels: [], extra: { customfield_00002: "Gold" } }, { category: "Tech debt" });
  assert.deepEqual(valuesOf(r, "group:product", cfg), ["Payments", "Notifications"]);
  assert.deepEqual(valuesOf(r, "group:layer", cfg), ["Frontend", "Backend"]);
  assert.deepEqual(valuesOf(row("A-2", { components: ["infra"] }), "group:product", cfg), ["Other"]);
  assert.deepEqual(valuesOf(row("A-2"), "component", cfg), ["(none)"]);
  assert.deepEqual(valuesOf(row("A-2"), "assignee", cfg), ["Unassigned"]);
  assert.deepEqual(valuesOf(r, "assignee", cfg), ["Sam"]);
  assert.deepEqual(valuesOf(r, "label", cfg), ["(none)"]);
  assert.deepEqual(valuesOf(r, "column:category", cfg), ["Tech debt"]);
  assert.deepEqual(valuesOf(row("A-3"), "column:category", cfg), ["(none)"]);
  assert.deepEqual(valuesOf(r, "field:customfield_00002", cfg), ["Gold"]);
  assert.deepEqual(valuesOf(row("A-3"), "field:customfield_00002", cfg), ["(none)"]);
});

test("split: shares of the view's real total, overlap counted, Other last", () => {
  const rows = [
    row("A-1", { components: ["pay UI", "notify-api"], storyPoints: 5, ...done }),
    row("A-2", { components: ["pay-api"], storyPoints: 3, ...ip }),
    row("A-3", { components: ["infra"], storyPoints: 2 }),
    row("A-4", { components: ["notify-ui"] }),
  ];
  const s = split(rows, "group:product", cfg, "points");
  assert.equal(s.total, 10);
  assert.equal(s.tickets, 4);
  assert.equal(s.unestimated, 1);
  assert.equal(s.overlap, 1);
  assert.deepEqual(s.items.map((i) => [i.value, i.measure, i.tickets, i.done, i.inProgress, i.todo, i.share]), [
    ["Payments", 8, 2, 5, 3, 0, 0.8],
    ["Notifications", 5, 2, 5, 0, 0, 0.5],
    ["Other", 2, 1, 0, 0, 2, 0.2],
  ]);
  const t = split(rows, "group:product", cfg, "tickets");
  assert.deepEqual(t.items.map((i) => [i.value, i.measure, i.share]), [["Payments", 2, 0.5], ["Notifications", 2, 0.5], ["Other", 1, 0.25]]);
});

test("complete: by points and tickets, unestimated counted", () => {
  const c = complete([row("A-1", { storyPoints: 4, ...done }), row("A-2", { storyPoints: 4 }), row("A-3", done)]);
  assert.deepEqual(c, { byPoints: 0.5, byTickets: 2 / 3, donePoints: 4, totalPoints: 8, doneTickets: 2, totalTickets: 3, unestimated: 1 });
  assert.deepEqual(complete([]), { byPoints: 0, byTickets: 0, donePoints: 0, totalPoints: 0, doneTickets: 0, totalTickets: 0, unestimated: 0 });
});

test("perPerson: open work, low flag rules, Unassigned last", () => {
  const rows = [
    row("A-1", { assignee: "Alex", storyPoints: 8 }),
    row("A-2", { assignee: "Mo", storyPoints: 1 }),
    row("A-3", { assignee: "Mo", storyPoints: 5, ...done }),
    row("A-4", { assignee: "Jo" }),
    row("A-5", { storyPoints: 2 }),
  ];
  assert.deepEqual(perPerson(rows, S), [
    { name: "Alex", open: 8, unestimated: 0, low: false },
    { name: "Mo", open: 1, unestimated: 0, low: true },
    { name: "Jo", open: 0, unestimated: 1, low: false },
    { name: "Unassigned", open: 2, unestimated: 0, low: false },
  ]);
  assert.deepEqual(perPerson(rows, { ...S, measure: "tickets" }).map((p) => [p.name, p.open, p.low]), [
    ["Alex", 1, true], ["Jo", 1, true], ["Mo", 1, true], ["Unassigned", 1, false],
  ]);
});

test("blockedReasons: status, flag, open blocking link; done ignored", () => {
  assert.deepEqual(blockedReasons(row("A-1", { status: "Blocked", statusCategoryKey: "indeterminate" }), S), ["status Blocked"]);
  assert.deepEqual(blockedReasons(row("A-1", { flagged: true }), S), ["flagged"]);
  const links = [
    { type: "is blocked by", direction: "inward" as const, key: "B-1", done: false },
    { type: "is blocked by", direction: "inward" as const, key: "B-2", done: true },
    { type: "blocks", direction: "outward" as const, key: "B-3", done: false },
    { type: "is blocked by", direction: "inward" as const, key: "B-4" },
  ];
  assert.deepEqual(blockedReasons(row("A-1", { links }), S), ["blocked by B-1", "blocked by B-4"]);
  assert.deepEqual(blockedReasons(row("A-1", { links }), { ...S, blocked: { ...S.blocked, links: false } }), []);
  assert.deepEqual(blockedReasons(row("A-1", { ...done, flagged: true, links }), S), []);
});

test("stalled, moving and attention order", () => {
  const stale = row("A-1", { ...ip, updated: daysAgo(6) });
  const older = row("A-2", { ...ip, updated: daysAgo(9) });
  const fresh = row("A-3", { ...ip, updated: daysAgo(1) });
  const blocked = row("A-4", { ...ip, flagged: true, updated: daysAgo(10) });
  const todo = row("A-5", { updated: daysAgo(20) });
  assert.ok(isStalled(stale, S, NOW));
  assert.ok(!isStalled(fresh, S, NOW));
  assert.ok(!isStalled(blocked, S, NOW), "blocked isn't also stalled");
  assert.ok(!isStalled(todo, S, NOW), "only in-progress tickets stall");
  assert.ok(isMoving(fresh, S, NOW));
  assert.ok(!isMoving(stale, S, NOW));
  const a = attention([stale, fresh, blocked, older, todo], S, NOW);
  assert.deepEqual(a.map((x) => [x.row.ticket.key, x.blocked, x.why]), [
    ["A-4", true, "flagged"],
    ["A-2", false, "idle 9d"],
    ["A-1", false, "idle 6d"],
  ]);
});

test("sprintOf picks the active sprint with dates most rows are in", () => {
  const sp = (name: string, state = "active") => ({ name, state, startDate: "2026-10-26T12:00:00.000Z", endDate: "2026-11-06T12:00:00.000Z" });
  const rows = [row("A-1", { sprints: [sp("S42")] }), row("A-2", { sprints: [sp("S41", "closed"), sp("S42")] }), row("A-3", { sprints: [sp("S43")] })];
  const s = sprintOf(rows)!;
  assert.equal(s.name, "S42");
  assert.equal(s.start.getDate(), 26);
  assert.equal(sprintOf([row("A-1", { sprints: [{ name: "S1", state: "active" }] })]), null);
  assert.equal(sprintOf([row("A-1")]), null);
});

test("sprintPosition: W/D, days left, freeze, weekends and edges", () => {
  const sp = { name: "S42", start: new Date(2026, 9, 26), end: new Date(2026, 10, 6) };
  const freeze = { week: 2, day: 3 };
  const p = sprintPosition(sp, freeze, NOW);
  assert.deepEqual([p.week, p.day, p.daysLeft, p.toFreeze, p.freezePassed, p.ended, p.notStarted], [1, 4, 6, 4, false, false, false]);
  assert.equal(p.days.length, 10);
  assert.equal(p.days.findIndex((d) => d.today), 3);
  assert.equal(p.days.findIndex((d) => d.freeze), 7);
  assert.equal(p.days.filter((d) => d.past).length, 3);
  const sat = sprintPosition(sp, freeze, new Date(2026, 9, 31, 10));
  assert.deepEqual([sat.week, sat.day, sat.daysLeft], [1, 5, 5]);
  const onFreeze = sprintPosition(sp, freeze, new Date(2026, 10, 4, 9));
  assert.deepEqual([onFreeze.toFreeze, onFreeze.freezePassed], [0, false]);
  const after = sprintPosition(sp, freeze, new Date(2026, 10, 5, 9));
  assert.deepEqual([after.toFreeze, after.freezePassed], [null, true]);
  assert.equal(sprintPosition(sp, null, NOW).toFreeze, null);
  assert.ok(sprintPosition(sp, freeze, new Date(2026, 10, 9)).ended);
  assert.ok(sprintPosition(sp, freeze, new Date(2026, 9, 20)).notStarted);
});

test("drillRows returns exactly the chart's members", () => {
  const rows = [
    row("A-1", { components: ["pay UI", "notify-api"], assignee: "Sam", ...done }),
    row("A-2", { components: ["infra"], ...ip, updated: daysAgo(8) }),
    row("A-3", { ...ip, flagged: true }),
    row("A-4", { ...ip, updated: daysAgo(0), assignee: "Sam" }),
  ];
  const keys = (rs: Row[]) => rs.map((r) => r.ticket.key);
  assert.deepEqual(keys(drillRows(rows, { kind: "value", by: "group:product", value: "Notifications", label: "" }, cfg, S, NOW)), ["A-1"]);
  assert.deepEqual(keys(drillRows(rows, { kind: "value", by: "group:product", value: "Other", label: "" }, cfg, S, NOW)), ["A-2", "A-3", "A-4"]);
  assert.deepEqual(keys(drillRows(rows, { kind: "value", by: "assignee", value: "Unassigned", label: "" }, cfg, S, NOW)), ["A-2", "A-3"]);
  assert.deepEqual(keys(drillRows(rows, { kind: "blocked", label: "" }, cfg, S, NOW)), ["A-3"]);
  assert.deepEqual(keys(drillRows(rows, { kind: "stalled", label: "" }, cfg, S, NOW)), ["A-2"]);
  assert.deepEqual(keys(drillRows(rows, { kind: "moving", label: "" }, cfg, S, NOW)), ["A-4"], "blocked isn't moving");
  assert.deepEqual(keys(drillRows(rows, { kind: "done", label: "" }, cfg, S, NOW)), ["A-1"]);
  assert.deepEqual(keys(drillRows(rows, { kind: "unassigned", label: "" }, cfg, S, NOW)), ["A-2", "A-3"]);
});

test("review: clicking a person drills to their open tickets only, matching perPerson", () => {
  const rows = [
    row("A-1", { assignee: "Sam", storyPoints: 2, ...ip }),
    row("A-2", { assignee: "Sam", storyPoints: 5, ...done }),
    row("A-3", { storyPoints: 1 }),
    row("A-4", { storyPoints: 3, ...done }),
  ];
  const keys = (rs: Row[]) => rs.map((r) => r.ticket.key);
  assert.deepEqual(keys(drillRows(rows, { kind: "person", value: "Sam", label: "" }, cfg, S, NOW)), ["A-1"]);
  assert.deepEqual(keys(drillRows(rows, { kind: "person", value: "Unassigned", label: "" }, cfg, S, NOW)), ["A-3"]);
  const sam = perPerson(rows, { ...S, measure: "tickets" }).find((p) => p.name === "Sam")!;
  assert.equal(sam.open, 1);
});

test("review: the flag only blocks while flagField is set", () => {
  assert.deepEqual(blockedReasons(row("A-1", { flagged: true }), { ...S, blocked: { ...S.blocked, flagField: null } }), []);
});

test("review: countdown is dropped without a sprint, even when listed", () => {
  const c = parseAnalysisConfig({ views: { v: { charts: ["countdown", "progress"] }, w: {} } });
  assert.deepEqual(chartsFor(c, "v", false).charts, [{ type: "progress" }]);
  assert.deepEqual(chartsFor(c, "v", true).charts.map((x) => x.type), ["countdown", "progress"]);
  assert.equal(chartsFor(c, "w", false).charts[0]!.type, "headlines");
});

test("review: no 'today' outside the sprint", () => {
  const sp = { name: "S42", start: new Date(2026, 9, 26), end: new Date(2026, 10, 6) };
  const before = sprintPosition(sp, null, new Date(2026, 9, 20));
  assert.equal(before.days.some((d) => d.today), false);
  assert.equal(before.inSprint, false);
  const afterWeekend = sprintPosition(sp, null, new Date(2026, 10, 7, 10)); // Sat after a Fri end
  assert.ok(afterWeekend.ended);
  assert.equal(afterWeekend.days.some((d) => d.today), false);
  assert.equal(afterWeekend.inSprint, false);
  assert.equal(sprintPosition(sp, null, NOW).inSprint, true);
});

test("valuesOf: column:<id> reads a Jira column too", () => {
  const r = { ...row("A-1"), jira: { release: "1.2" } };
  assert.deepEqual(valuesOf(r, "column:release", cfg), ["1.2"]);
  assert.deepEqual(valuesOf(row("A-2"), "column:release", cfg), ["(none)"]);
});

test("valuesOf: a multi-value Jira column or field counts under each value", () => {
  const r = { ...row("A-1", { extra: { customfield_00002: "1.2, 1.3" } }), jira: { release: "1.2, 1.3" } };
  assert.deepEqual(valuesOf(r, "column:release", cfg), ["1.2", "1.3"]);
  assert.deepEqual(valuesOf(r, "field:customfield_00002", cfg), ["1.2", "1.3"]);
  assert.deepEqual(valuesOf({ ...row("A-2"), custom: { category: "a, b" } }, "column:category", cfg), ["a, b"], "your own columns are single values");
});
