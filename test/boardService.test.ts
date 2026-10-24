import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardService, BOARD_CACHE_ID } from "../src/server/boardService.ts";
import { ViewCache } from "../src/server/cache.ts";
import { NotesStore } from "../src/server/notesStore.ts";
import { JiraError, type JiraClient } from "../src/server/jira.ts";
import { parseBoard } from "../src/server/board.ts";
import type { IssueDetail, LiveEvent, Ticket } from "../src/shared/types.ts";

const t = (key: string, id = key) => ({ id, key, summary: `s ${key}`, updated: "2026-10-01T00:00:00Z" }) as Ticket;
const backlog = (dir: string) => parseBoard(fs.readFileSync(path.join(dir, "board.yaml"), "utf8"), "board.yaml").cards.Backlog;
const detail = (ticket: Ticket) => ({ ticket, descriptionMd: "", acceptanceCriteriaMd: null, comments: [] }) as IssueDetail;

function setup(
  keys: string[],
  jiraImpl: { search?: JiraClient["search"]; getIssueDetail?: JiraClient["getIssueDetail"] } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
  if (keys.length) {
    fs.writeFileSync(
      path.join(dir, "board.yaml"),
      `columns: [Backlog, Doing, PEN, Done]\narchiveColumn: Done\ncards:\n  Backlog: [${keys.join(", ")}]\n  Doing: []\n  PEN: []\n  Done: []\n`,
    );
  }
  const searches: string[] = [];
  const details: string[] = [];
  const jira = {
    search: async (jql: string, limit: number) => {
      searches.push(jql);
      return jiraImpl.search ? jiraImpl.search(jql, limit) : keys.map((k) => t(k));
    },
    getIssueDetail: async (k: string) => {
      details.push(k);
      if (!jiraImpl.getIssueDetail) throw new Error("unused");
      return jiraImpl.getIssueDetail(k);
    },
  } as unknown as JiraClient;
  const events: LiveEvent[] = [];
  const cache = new ViewCache(dir);
  const notes = new NotesStore(dir);
  const svc = new BoardService({
    jira, cache, notes, notesDir: dir, statePath: path.join(dir, ".cache", "board-state.json"),
    onChange: (e) => events.push(e), now: () => new Date("2026-10-24T10:00:00Z"),
  });
  return { dir, jira, searches, details, events, cache, notes, svc };
}

test("refresh caches all returned starred tickets and emits board", async () => {
  const { svc, cache, events } = setup(["A-1", "A-2", "A-3"]);
  await svc.refresh();
  const c = await cache.read(BOARD_CACHE_ID);
  assert.equal(c.tickets.length, 3);
  assert.equal(c.error, null);
  assert.equal(c.fetchedAt, "2026-10-24T10:00:00.000Z");
  assert.deepEqual(events.filter((e) => e.type === "board").length, 1);
  assert.equal((await svc.tickets()).size, 3);
});

test("deleted key is shown missing, others load, and not-found is remembered for 24h", async () => {
  const { svc, details } = setup(["A-1", "GONE-1", "A-2"], {
    search: async () => { throw new JiraError(400, ["does not exist"]); },
    getIssueDetail: async (k) => {
      if (k === "GONE-1") throw new JiraError(404, ["nope"]);
      return detail(t(k));
    },
  });
  await svc.refresh();
  const v = await svc.view([], []);
  const cards = v.cards.Backlog;
  assert.deepEqual(cards.map((c) => c.key), ["A-1", "GONE-1", "A-2"]);
  assert.equal(cards[1].missing, true);
  assert.equal(cards[1].row, null);
  assert.ok(cards[0].row && !cards[0].missing);
  assert.ok(cards[2].row);
  assert.equal(v.error, null);
  assert.equal(v.locked, false);
  await svc.refresh();
  assert.equal(details.filter((k) => k === "GONE-1").length, 1);
});

test("rename without a note file updates board.yaml in place and creates no note", async () => {
  const { svc, dir, events } = setup(["A-1", "OLD-1", "A-2"], {
    search: async () => [t("A-1"), t("A-2")],
    getIssueDetail: async () => detail(t("NEW-1")),
  });
  await svc.refresh();
  assert.deepEqual(backlog(dir), ["A-1", "NEW-1", "A-2"]);
  assert.ok(!fs.existsSync(path.join(dir, "jira", "notes", "NEW-1.md")));
  assert.ok(!fs.existsSync(path.join(dir, "jira", "notes", "OLD-1.md")));
  assert.ok(events.some((e) => e.type === "board"));
  assert.equal((await svc.tickets()).get("NEW-1")!.key, "NEW-1");
});

test("rename with a note file moves the note", async () => {
  const { svc, dir, notes, events } = setup(["OLD-1"], {
    search: async () => [],
    getIssueDetail: async () => detail(t("NEW-1")),
  });
  await notes.writeNoteBody("OLD-1", "hello", { baseMtimeMs: null });
  await svc.refresh();
  assert.ok(fs.existsSync(path.join(dir, "jira", "notes", "NEW-1.md")));
  assert.ok(!fs.existsSync(path.join(dir, "jira", "notes", "OLD-1.md")));
  assert.deepEqual(backlog(dir), ["NEW-1"]);
  assert.ok(events.some((e) => e.type === "note" && e.key === "NEW-1"));
  assert.ok(events.some((e) => e.type === "groom" && e.key === "NEW-1"));
});

test("a non-400 search error keeps previous tickets, records the error, skips per-key lookups", async () => {
  let fail = false;
  const { svc, cache, details } = setup(["A-1", "A-2"], {
    search: async () => {
      if (fail) throw new JiraError(500, ["boom"]);
      return [t("A-1"), t("A-2")];
    },
  });
  await svc.refresh();
  fail = true;
  await svc.refresh();
  const c = await cache.read(BOARD_CACHE_ID);
  assert.equal(c.tickets.length, 2);
  assert.equal(c.error, "boom");
  assert.equal(details.length, 0);
});

test("apply add of an unknown key starts a refresh", async () => {
  const { svc, searches } = setup(["A-1"]);
  await svc.apply({ op: "add", key: "X-1" });
  for (let i = 0; i < 50 && searches.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(searches.length, 1);
  assert.match(searches[0], /X-1/);
});

test("apply add of a key already in a view cache does not refresh", async () => {
  const { svc, searches, cache } = setup(["A-1"]);
  await cache.write("current", { fetchedAt: null, tickets: [t("X-1")], error: null });
  await svc.apply({ op: "add", key: "X-1" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(searches.length, 0);
});

test("view on a broken board.yaml is locked and names the file", async () => {
  const { svc, dir } = setup([]);
  fs.writeFileSync(path.join(dir, "board.yaml"), "columns: [");
  const v = await svc.view([], []);
  assert.equal(v.locked, true);
  assert.match(v.error!, /board\.yaml/);
  assert.deepEqual(v.columns, []);
  assert.deepEqual(v.cards, {});
});

test("refresh on a broken board.yaml leaves the cache untouched", async () => {
  const { svc, dir, searches } = setup([]);
  fs.writeFileSync(path.join(dir, "board.yaml"), "columns: [");
  await svc.refresh();
  assert.equal(searches.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, ".cache", "views", "_board.json")));
});

test("a just-starred key only in a view cache gets a row from that view", async () => {
  const { svc, cache } = setup(["X-1"]);
  await cache.write("current", { fetchedAt: null, tickets: [t("X-1")], error: null });
  const v = await svc.view([], ["current"]);
  assert.equal(v.cards.Backlog[0].row!.ticket.key, "X-1");
  assert.equal(v.cards.Backlog[0].missing, false);
  const none = await svc.view([], []);
  assert.equal(none.cards.Backlog[0].row, null);
});

test("rename() renames in the board and emits board only if changed", async () => {
  const { svc, dir, events } = setup(["OLD-1"]);
  await svc.rename("OLD-1", "NEW-1");
  assert.deepEqual(backlog(dir), ["NEW-1"]);
  assert.equal(events.filter((e) => e.type === "board").length, 1);
  await svc.rename("OLD-1", "NEW-2");
  assert.equal(events.filter((e) => e.type === "board").length, 1);
});
