import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ViewCache } from "../src/server/cache.ts";
import { Refresher } from "../src/server/refresher.ts";
import { NotesStore } from "../src/server/notesStore.ts";
import { JiraError, type JiraClient } from "../src/server/jira.ts";
import type { LiveEvent, Ticket, View } from "../src/shared/types.ts";

const view: View = { id: "current", name: "Current", jql: "project = PAY", limit: 50, columns: [], filters: {} };
const t = (id: string, key: string) => ({ id, key, summary: "s" }) as Ticket;

function setup(search: JiraClient["search"], brief: JiraClient["getIssueBrief"] = async () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-"));
  const notes = new NotesStore(dir);
  const cache = new ViewCache(dir);
  const events: LiveEvent[] = [];
  const jira = { search, getIssueBrief: brief, getIssueDetail: async () => { throw new Error("unused"); } } as JiraClient;
  const r = new Refresher({
    jira, cache, notes, getViews: async () => [view], onChange: (e) => events.push(e),
    statePath: path.join(dir, ".cache", "reconcile.json"), now: () => new Date("2026-10-24T10:00:00Z"),
  });
  return { dir, notes, cache, events, r };
}

test("cache read returns empty when missing or corrupt", async () => {
  const { dir, cache } = setup(async () => []);
  assert.deepEqual(await cache.read("nope"), { fetchedAt: null, tickets: [], error: null });
  fs.mkdirSync(path.join(dir, ".cache", "views"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".cache", "views", "bad.json"), "{nope");
  assert.deepEqual(await cache.read("bad"), { fetchedAt: null, tickets: [], error: null });
});

test("successful refresh writes cache, adds identity to existing note, emits rows", async () => {
  const { notes, cache, events, r } = setup(async () => [t("100", "PAY-1")]);
  await notes.writeNoteBody("PAY-1", "hi", { baseMtimeMs: null });
  const v = await r.refreshView(view);
  assert.equal(v.error, null);
  assert.equal(v.fetchedAt, "2026-10-24T10:00:00.000Z");
  assert.equal((await cache.read("current")).tickets[0].key, "PAY-1");
  assert.equal((await notes.readNote("PAY-1"))!.data.jira_id, "100");
  assert.deepEqual(events, [{ type: "rows", viewId: "current" }]);
  assert.equal((await cache.allTickets(["current"])).get("PAY-1")!.id, "100");
});

test("failed refresh keeps tickets and fetchedAt, sets error, emits rows", async () => {
  let fail = false;
  const { cache, events, r } = setup(async () => {
    if (fail) throw new JiraError(400, ["bad jql"]);
    return [t("100", "PAY-1")];
  });
  const first = await r.refreshView(view);
  fail = true;
  events.length = 0;
  const second = await r.refreshView(view);
  assert.equal(second.error, "bad jql");
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.tickets.length, 1);
  assert.equal((await cache.read("current")).error, "bad jql");
  assert.deepEqual(events, [{ type: "rows", viewId: "current" }]);
});

test("non-JiraError exceptions are treated as failures", async () => {
  const { r } = setup(async () => { throw new Error("kaboom"); });
  assert.equal((await r.refreshView(view)).error, "kaboom");
});

test("refreshAll reconciles, emits orphans on change, and overlapping calls share a promise", async () => {
  const { notes, events, r } = setup(async () => [t("100", "PAY-1")]);
  await notes.writeNoteBody("GONE-1", "x", { baseMtimeMs: null, jiraId: "999" });
  const p1 = r.refreshAll();
  const p2 = r.refreshAll();
  assert.equal(p1, p2);
  await p1;
  assert.deepEqual(r.orphans(), ["GONE-1"]);
  assert.equal(events.filter((e) => e.type === "orphans").length, 1);
  await r.refreshAll();
  assert.equal(events.filter((e) => e.type === "orphans").length, 1);
});

test("one view failing to persist does not abort the cycle", async () => {
  const { dir, notes, r, events } = setup(async () => [t("100", "PAY-1")]);
  const views: View[] = [{ ...view, id: "bad" }, { ...view, id: "good" }];
  const r2 = new Refresher({
    jira: { search: async () => [t("100", "PAY-1")], getIssueBrief: async () => null, getIssueDetail: async () => { throw new Error("x"); } } as JiraClient,
    cache: new ViewCache(dir), notes, getViews: async () => views, onChange: (e) => events.push(e),
    statePath: path.join(dir, ".cache", "reconcile.json"),
  });
  fs.mkdirSync(path.join(dir, ".cache", "views", "bad.json"), { recursive: true });
  const orig = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    await r2.refreshAll();
  } finally {
    console.error = orig;
  }
  assert.equal(logged.length, 1);
  assert.ok(events.some((e) => e.type === "rows" && e.viewId === "good"));
  assert.ok(fs.existsSync(path.join(dir, ".cache", "reconcile.json")));
  void r;
});

test("start ticks on an interval and stop halts it", async () => {
  let calls = 0;
  const { r } = setup(async () => { calls++; return []; });
  r.start(0.0005);
  await new Promise((res) => setTimeout(res, 150));
  r.stop();
  assert.ok(calls >= 1);
  await new Promise((res) => setTimeout(res, 50));
  const after = calls;
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(calls, after);
});

test("runAll refreshes the board after views, counts board tickets as seen, and renames via board", async () => {
  const order: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-board-"));
  const notes = new NotesStore(dir);
  await notes.writeNoteBody("BOARD-1", "x", { baseMtimeMs: null, jiraId: "500" });
  await notes.writeNoteBody("OLD-1", "x", { baseMtimeMs: null, jiraId: "600" });
  const renames: [string, string][] = [];
  const board = {
    refresh: async () => { order.push("board"); },
    tickets: async () => new Map([["BOARD-1", t("500", "BOARD-1")], ["NEW-1", t("600", "NEW-1")]]),
    rename: async (o: string, n: string) => { renames.push([o, n]); },
  };
  const r = new Refresher({
    jira: { search: async () => { order.push("view"); return []; }, getIssueBrief: async () => null, getIssueDetail: async () => { throw new Error("x"); } } as unknown as JiraClient,
    cache: new ViewCache(dir), notes, getViews: async () => [view], onChange: () => {},
    statePath: path.join(dir, ".cache", "reconcile.json"), board,
  });
  await r.refreshAll();
  assert.deepEqual(order, ["view", "board"]);
  assert.deepEqual(r.orphans(), []);
  assert.deepEqual(renames, [["OLD-1", "NEW-1"]]);
});

test("a throwing board refresh is logged and does not abort the cycle", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-board-"));
  const board = { refresh: async () => { throw new Error("bd"); }, tickets: async () => new Map<string, Ticket>(), rename: async () => {} };
  const r = new Refresher({
    jira: { search: async () => [], getIssueBrief: async () => null } as unknown as JiraClient,
    cache: new ViewCache(dir), notes: new NotesStore(dir), getViews: async () => [view], onChange: () => {},
    statePath: path.join(dir, ".cache", "reconcile.json"), board,
  });
  const orig = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try { await r.refreshAll(); } finally { console.error = orig; }
  assert.equal(logged.length, 1);
});
