import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.ts";
import { watchNotesDir } from "../src/server/watcher.ts";
import { ViewCache } from "../src/server/cache.ts";
import { NotesStore } from "../src/server/notesStore.ts";
import { Refresher } from "../src/server/refresher.ts";
import { BoardService } from "../src/server/boardService.ts";
import { ReadingStore } from "../src/server/readingStore.ts";
import { ensureDataDir, loadColumns, loadViews } from "../src/server/configFiles.ts";
import type { Config } from "../src/server/config.ts";
import type { JiraClient } from "../src/server/jira.ts";
import type { IssueDetail, LiveEvent, Ticket } from "../src/shared/types.ts";

const ticket = (id: string, key: string): Ticket => ({
  id, key, url: `https://acme.example/browse/${key}`, summary: `Summary ${key}`, status: "To Do",
  statusCategory: "new", type: "Story", priority: null, assignee: null, reporter: null,
  storyPoints: 3, parent: null, labels: [], sprint: null, updated: "2026-10-20T10:00:00.000Z",
});
const tickets = [ticket("100", "PAY-1"), ticket("101", "PAY-2")];
const detail = (key: string): IssueDetail => ({
  ticket: tickets.find((t) => t.key === key) ?? ticket("999", key),
  descriptionMd: "Hello <script>alert(1)</script>",
  acceptanceCriteriaMd: null,
  comments: [{ author: "Ann", created: "2026-10-01T00:00:00Z", bodyMd: "c1" }],
});
const jira: JiraClient = {
  search: async () => tickets,
  getIssueDetail: async (k) => detail(k),
  getIssueBrief: async () => null,
};

let dir: string;
let server: http.Server;
let port: number;
let stopWatch: () => void;
let refresherRef: Refresher;
let boardRef: BoardService;
const base = () => `http://localhost:${port}`;
const J = { "Content-Type": "application/json" };
const put = (p: string, body: unknown, headers: Record<string, string> = J) =>
  fetch(base() + p, { method: "PUT", headers, body: JSON.stringify(body) });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));
  await ensureDataDir(dir, "PAY", path.resolve("examples"));
  const publicDir = path.join(dir, "public");
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
  const config = { jiraBaseUrl: "https://acme.example", notesDir: dir } as Config;
  const notes = new NotesStore(dir);
  const cache = new ViewCache(dir);
  let broadcast: (e: LiveEvent) => void = () => {};
  const refresher = new Refresher({
    jira, cache, notes,
    getViews: async () => loadViews(dir, await loadColumns(dir)),
    onChange: (e) => broadcast(e),
    statePath: path.join(dir, ".cache", "reconcile.json"),
  });
  refresherRef = refresher;
  const board = new BoardService({
    jira, cache, notes, notesDir: dir,
    statePath: path.join(dir, ".cache", "board-state.json"),
    onChange: (e) => broadcast(e),
  });
  boardRef = board;
  const app = createApp({ config, jira, notes, cache, refresher, board, reading: new ReadingStore(dir), publicDir });
  broadcast = app.broadcast;
  server = app.server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  stopWatch = watchNotesDir(dir, app.broadcast);
});

after(async () => {
  await boardRef.refresh(); // settle any background refresh triggered by an add
  stopWatch();
  server.closeAllConnections();
  server.close();
});

function rawRequest(p: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET /api/config returns the 3 example views, columns and jira url", async () => {
  const res = await fetch(base() + "/api/config");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.views.map((v: { id: string }) => v.id), ["current", "next", "backlog"]);
  assert.equal(body.error, null);
  assert.equal(body.jiraBaseUrl, "https://acme.example");
  assert.ok(body.columns.custom.category);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(body.links, []); // no links.yaml yet
  assert.equal(body.linksError, null);
});

test("GET /api/config carries links.yaml links, warnings for bad entries, and survives broken YAML", async () => {
  const file = path.join(dir, "links.yaml");
  fs.writeFileSync(file, "links:\n  - { name: Roadmap, url: https://roadmap.example.com, icon: map }\n  - { name: Bad, url: ftp://x.example.com }\n");
  let body = await (await fetch(base() + "/api/config")).json();
  assert.deepEqual(body.links, [{ name: "Roadmap", url: "https://roadmap.example.com/", icon: { kind: "named", name: "map" }, newTab: true }]);
  assert.match(body.linksError, /^links\.yaml: "Bad" url/);
  assert.equal(body.error, null); // views and columns are unaffected
  fs.writeFileSync(file, "links: [ {");
  body = await (await fetch(base() + "/api/config")).json();
  assert.deepEqual(body.links, []);
  assert.match(body.linksError, /links\.yaml: invalid YAML/);
  assert.equal(body.views.length, 3);
  fs.rmSync(file);
});

test("refresh then rows returns the fake tickets; unknown view is 404", async () => {
  const r = await fetch(base() + "/api/views/current/refresh", { method: "POST", headers: J });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rows.length, 2);
  const res = await fetch(base() + "/api/views/current/rows");
  const body = await res.json();
  assert.deepEqual(body.rows.map((x: { ticket: Ticket }) => x.ticket.key), ["PAY-1", "PAY-2"]);
  assert.equal(body.error, null);
  assert.ok(body.fetchedAt);
  assert.equal((await fetch(base() + "/api/views/nope/rows")).status, 404);
  assert.equal((await fetch(base() + "/api/views/nope/refresh", { method: "POST", headers: J })).status, 404);
});

test("note save creates file with jira_id; stale base after external edit is 409", async () => {
  const res = await put("/api/notes/PAY-1", { body: "first", baseMtimeMs: null });
  assert.equal(res.status, 200);
  const { mtimeMs } = await res.json();
  const file = path.join(dir, "jira", "notes", "PAY-1.md");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /jira_id: ['"]?100/);
  fs.writeFileSync(file, text + "\nexternal edit\n");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  const conflict = await put("/api/notes/PAY-1", { body: "mine", baseMtimeMs: mtimeMs });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).current.body, /external edit/);
  const forced = await put("/api/notes/PAY-1", { body: "mine", baseMtimeMs: mtimeMs, force: true });
  assert.equal(forced.status, 200);
  const rows = await (await fetch(base() + "/api/views/current/rows")).json();
  assert.equal(rows.rows[0].note.body.trim(), "mine");
});

test("note save after the note was deleted on disk is 409 with a readable error and recreates nothing", async () => {
  const res = await put("/api/notes/PAY-2", { body: "first", baseMtimeMs: null });
  const { mtimeMs } = await res.json();
  const file = path.join(dir, "jira", "notes", "PAY-2.md");
  fs.rmSync(file);
  const r = await put("/api/notes/PAY-2", { body: "mine", baseMtimeMs: mtimeMs });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.current, null);
  assert.match(body.error, /deleted on disk/);
  assert.equal(fs.existsSync(file), false);
});

test("field writes: valid custom field ok, bad key/builtin/bad value rejected", async () => {
  assert.equal((await put("/api/notes/..%2Fx/fields/category", { value: "a" })).status, 400);
  assert.equal((await put("/api/notes/PAY-1/fields/status", { value: "a" })).status, 400);
  assert.equal((await put("/api/notes/PAY-1/fields/category", { value: 5 })).status, 400);
  assert.equal((await put("/api/notes/pay-1", { body: "x", baseMtimeMs: null })).status, 400);
  const ok = await put("/api/notes/PAY-2/fields/category", { value: "tech-debt" });
  assert.equal(ok.status, 200);
  assert.match(fs.readFileSync(path.join(dir, "jira", "notes", "PAY-2.md"), "utf8"), /category: tech-debt/);
});

test("security: bad origin 403, bad content-type 415, bad host 421", async () => {
  const evil = await put("/api/notes/PAY-1", { body: "x", baseMtimeMs: 0 }, { ...J, Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  const okOrigin = await put("/api/notes/PAY-3", { body: "x", baseMtimeMs: null }, { ...J, Origin: base() });
  assert.equal(okOrigin.status, 200);
  const plain = await fetch(base() + "/api/notes/PAY-1", { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 415);
  const host = await rawRequest("/api/config", { Host: "evil.example:1234" });
  assert.equal(host.status, 421);
  assert.equal(host.headers["content-security-policy"] !== undefined, true);
  const loop = await rawRequest("/api/config", { Host: `127.0.0.1:${port}` });
  assert.equal(loop.status, 200);
});

test("body limits and invalid JSON", async () => {
  const bad = await fetch(base() + "/api/notes/PAY-1", { method: "PUT", headers: J, body: "{nope" });
  assert.equal(bad.status, 400);
  const big = await fetch(base() + "/api/notes/PAY-1", { method: "PUT", headers: J, body: JSON.stringify({ body: "x".repeat(1_100_000), baseMtimeMs: 0 }) });
  assert.equal(big.status, 413);
});

test("static: serves index, never outside publicDir, only GET/HEAD, headers on all", async () => {
  const idx = await fetch(base() + "/");
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get("content-type")!, /text\/html/);
  assert.equal(await idx.text(), "<h1>hi</h1>");
  assert.equal((await fetch(base() + "/../secret.txt")).status, 404);
  assert.equal((await fetch(base() + "/%2e%2e/secret.txt")).status, 404);
  assert.equal((await fetch(base() + "/..%2fsecret.txt")).status, 404);
  assert.equal((await fetch(base() + "/%E0%A4%A")).status, 400);
  assert.equal((await fetch(base() + "/missing.js")).status, 404);
  assert.equal((await fetch(base() + "/", { method: "POST", headers: J, body: "{}" })).status, 405);
  for (const p of ["/", "/api/config", "/missing", "/api/nope"]) {
    const r = await fetch(base() + p);
    assert.equal(
      r.headers.get("content-security-policy"),
      "default-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await fetch(base() + "/api/nope")).status, 404);
});

test("ticket detail renders markdown safely; copy kinds; orphans", async () => {
  const res = await fetch(base() + "/api/tickets/PAY-1");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(!body.html.description.includes("<script>"));
  assert.equal(body.html.comments.length, 1);
  assert.equal(body.note.key, "PAY-1");
  assert.equal(body.groom, null);
  assert.ok(body.groomPath.endsWith(path.join("jira", "groom", "PAY-1.md")));
  assert.equal((await fetch(base() + "/api/tickets/nope")).status, 400);

  const prompt = await fetch(base() + "/api/tickets/PAY-1/copy/prompt");
  assert.match(prompt.headers.get("content-type")!, /text\/plain/);
  assert.ok((await prompt.text()).includes("jira/groom/PAY-1.md"));
  const both = await (await fetch(base() + "/api/tickets/PAY-1/copy/both")).text();
  assert.match(both, /# PAY-1: Summary PAY-1/);
  assert.match(both, /# My notes/);
  assert.equal((await fetch(base() + "/api/tickets/PAY-1/copy/ticket")).status, 200);
  assert.equal((await fetch(base() + "/api/tickets/PAY-1/copy/notes")).status, 200);
  assert.equal((await fetch(base() + "/api/tickets/PAY-1/copy/bogus")).status, 400);
  assert.deepEqual(await (await fetch(base() + "/api/orphans")).json(), { orphans: [] });
  const orig = refresherRef.orphans;
  refresherRef.orphans = () => ["GONE-1"];
  try {
    const { orphans } = await (await fetch(base() + "/api/orphans")).json();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].key, "GONE-1");
    assert.ok(orphans[0].notePath.endsWith(path.join("jira", "notes", "GONE-1.md")));
    assert.ok(orphans[0].groomPath.endsWith(path.join("jira", "groom", "GONE-1.md")));
  } finally {
    refresherRef.orphans = orig;
  }
});

test("ticket detail: Jira 404 is 404 not found; other jira failure is 502; unexpected error is 500 without details", async () => {
  const { JiraError } = await import("../src/server/jira.ts");
  const orig = jira.getIssueDetail;
  jira.getIssueDetail = async () => { throw new JiraError(404, ["Issue does not exist"]); };
  const r404 = await fetch(base() + "/api/tickets/PAY-1");
  assert.equal(r404.status, 404);
  assert.deepEqual(await r404.json(), { error: "PAY-1 not found in Jira (deleted, or no permission)" });
  jira.getIssueDetail = async () => { throw new JiraError(503, ["Service unavailable"]); };
  const r = await fetch(base() + "/api/tickets/PAY-1");
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /unavailable/);
  jira.getIssueDetail = async () => { throw new Error("secret /Users/x/token"); };
  const logged = test.mock.method(console, "error", () => {});
  const r2 = await fetch(base() + "/api/tickets/PAY-1");
  logged.mock.restore();
  assert.equal(r2.status, 500);
  assert.deepEqual(await r2.json(), { error: "Internal error" });
  assert.ok(logged.mock.callCount() > 0);
  jira.getIssueDetail = orig;
});

test("PUT /api/views validates, saves, and never writes invalid input", async () => {
  const file = path.join(dir, "views.yaml");
  const before = fs.readFileSync(file, "utf8");
  const bad = await put("/api/views", { views: [{ id: "Bad Id", name: "x", jql: "y" }] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /views\.yaml/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal((await put("/api/views", { nope: 1 })).status, 400);
  const views = [{ id: "mine", name: "Mine", jql: "assignee = me", limit: 10, columns: [{ id: "key" }], filters: {} }];
  assert.equal((await put("/api/views", { views })).status, 204);
  const cfg = await (await fetch(base() + "/api/config")).json();
  assert.deepEqual(cfg.views.map((v: { id: string }) => v.id), ["mine"]);
});

test("PUT /api/views round-trips a column width into views.yaml", async () => {
  const views = [{ id: "mine", name: "Mine", jql: "x", limit: 10, columns: [{ id: "key", width: 64 }, { id: "summary" }], filters: {} }];
  assert.equal((await put("/api/views", { views })).status, 204);
  assert.match(fs.readFileSync(path.join(dir, "views.yaml"), "utf8"), /width: 64/);
  const cfg = await (await fetch(base() + "/api/config")).json();
  assert.deepEqual(cfg.views[0].columns, [{ id: "key", width: 64 }, { id: "summary" }]);
});

test("corrupt views.yaml gives 200 with error naming the file", async () => {
  fs.writeFileSync(path.join(dir, "views.yaml"), "views: [unclosed\n  - : :");
  const res = await fetch(base() + "/api/config");
  assert.equal(res.status, 200);
  assert.match((await res.json()).error, /views\.yaml/);
});

test("PUT /api/views refuses with 409 and leaves a corrupt views.yaml byte-identical", async () => {
  const file = path.join(dir, "views.yaml");
  const broken = "views: [unclosed\n  - : :";
  fs.writeFileSync(file, broken);
  const views = [{ id: "mine", name: "Mine", jql: "assignee = me", limit: 10, columns: [{ id: "key" }], filters: {} }];
  const res = await put("/api/views", { views });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /views\.yaml/);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
});

test("PUT /api/views refuses with 409 when columns.yaml is corrupt", async () => {
  const vfile = path.join(dir, "views.yaml");
  const cfile = path.join(dir, "columns.yaml");
  const cBefore = fs.readFileSync(cfile, "utf8");
  fs.writeFileSync(vfile, "views: []\n");
  fs.writeFileSync(cfile, "custom: [oops\n");
  try {
    const res = await put("/api/views", { views: [{ id: "mine", name: "Mine", jql: "x" }] });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /columns\.yaml/);
    assert.equal(fs.readFileSync(vfile, "utf8"), "views: []\n");
  } finally {
    fs.writeFileSync(cfile, cBefore);
  }
});

test("SSE delivers a groom event when a groom file is written", async () => {
  const ac = new AbortController();
  const res = await fetch(base() + "/api/events", { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  setTimeout(() => fs.writeFileSync(path.join(dir, "jira", "groom", "PAY-1.md"), "---\nreadiness: ready\n---\nbody\n"), 100);
  let buf = "";
  const deadline = Date.now() + 2000;
  while (!buf.includes('data: {"type":"groom","key":"PAY-1"}') && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    if (!r || r.done) break;
    buf += decoder.decode(r.value);
  }
  ac.abort();
  assert.ok(buf.includes('data: {"type":"groom","key":"PAY-1"}\n\n'), buf);
});

const boardFile = () => path.join(dir, "board.yaml");
const postOp = (body: unknown, headers: Record<string, string> = J) =>
  fetch(base() + "/api/board/ops", { method: "POST", headers, body: JSON.stringify(body) });

test("GET /api/board on a fresh data dir returns 4 empty columns, unlocked", async () => {
  const res = await fetch(base() + "/api/board");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.columns.length, 4);
  assert.equal(body.locked, false);
  for (const c of body.columns) assert.deepEqual(body.cards[c], []);
});

const resetBoard = () => fs.rmSync(boardFile(), { force: true, recursive: true });

test("board op add puts the card in Backlog and persists it", async () => {
  resetBoard();
  const add = await postOp({ op: "add", key: "PAY-1" });
  assert.equal(add.status, 200);
  assert.equal((await add.json()).cards.Backlog[0].key, "PAY-1");
  assert.match(fs.readFileSync(boardFile(), "utf8"), /PAY-1/);
});

test("board op move puts the card in the target column", async () => {
  resetBoard();
  await postOp({ op: "add", key: "PAY-1" });
  const move = await postOp({ op: "move", key: "PAY-1", column: "Doing", index: 0 });
  assert.equal(move.status, 200);
  const moved = await move.json();
  assert.equal(moved.cards.Doing[0].key, "PAY-1");
  assert.deepEqual(moved.cards.Backlog, []);
});

test("board ops reject bad shapes and semantics with 400", async () => {
  resetBoard();
  await postOp({ op: "add", key: "PAY-1" });
  const bad: unknown[] = [
    { op: "move", key: "PAY-1", column: "Nope", index: 0 },
    { op: "add", key: "../x" },
    { op: "explode" },
    { op: "move", key: "PAY-1", column: "Doing", index: -1 },
    { op: "move", key: "PAY-1", column: "Doing", index: 1.5 },
    { op: "add", key: 5 },
    { op: "move", key: "PAY-1", column: 7, index: 0 },
  ];
  for (const b of bad) assert.equal((await postOp(b)).status, 400, JSON.stringify(b));
});

test("POST /api/board/refresh returns the board with ticket rows", async () => {
  resetBoard();
  await postOp({ op: "add", key: "PAY-1" });
  const res = await fetch(base() + "/api/board/refresh", { method: "POST", headers: J });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cards.Backlog[0].row.ticket.key, "PAY-1");
});

test("cross-origin POST /api/board/ops is 403", async () => {
  const res = await postOp({ op: "archive" }, { ...J, Origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("GET /api/board survives corrupted views.yaml and columns.yaml", async () => {
  resetBoard();
  const warn = console.warn;
  console.warn = () => {};
  const files = ["views.yaml", "columns.yaml"].map((f) => path.join(dir, f));
  const saved = files.map((f) => fs.readFileSync(f));
  try {
    for (const f of files) fs.writeFileSync(f, "a: [unclosed\n  - : :");
    const res = await fetch(base() + "/api/board");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).locked, false);
  } finally {
    console.warn = warn;
    files.forEach((f, i) => fs.writeFileSync(f, saved[i]));
  }
});

test("fs error during an op is 409 with a fixed message and no path", async () => {
  resetBoard();
  fs.mkdirSync(boardFile());
  const err = console.error;
  console.error = () => {};
  try {
    const res = await postOp({ op: "add", key: "PAY-9" });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.equal(JSON.parse(text).error, "board.yaml could not be read or written");
    assert.ok(!text.includes("/"));
  } finally {
    console.error = err;
    resetBoard();
  }
});

test("non-fs error with a code stays a 500", async () => {
  const orig = boardRef.apply;
  const err = console.error;
  console.error = () => {};
  boardRef.apply = async () => { throw Object.assign(new Error("boom"), { code: "ERR_X" }); };
  try {
    const res = await postOp({ op: "archive" });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, "Internal error");
  } finally {
    boardRef.apply = orig;
    console.error = err;
  }
});

test("board ops enforce the Content-Type gate", async () => {
  assert.equal((await postOp({ op: "archive" }, { "Content-Type": "text/plain" })).status, 415);
});

test("corrupted board.yaml: GET is locked, ops are 409, file untouched", async () => {
  resetBoard();
  await postOp({ op: "add", key: "PAY-1" });
  const good = fs.readFileSync(boardFile());
  fs.writeFileSync(boardFile(), "columns: [unclosed\n  - : :");
  const bytes = fs.readFileSync(boardFile());
  try {
    const res = await fetch(base() + "/api/board");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).locked, true);
    const add = await postOp({ op: "add", key: "PAY-9" });
    assert.equal(add.status, 409);
    assert.ok((await add.json()).error);
    assert.deepEqual(fs.readFileSync(boardFile()), bytes);
  } finally {
    fs.writeFileSync(boardFile(), good);
  }
});

test("note save takes jira_id from the board cache for a ticket in no view", async () => {
  const cache = new ViewCache(dir);
  await cache.write("_board", { fetchedAt: new Date().toISOString(), tickets: [ticket("777", "PAY-77")], error: null });
  const res = await put("/api/notes/PAY-77", { body: "board-only", baseMtimeMs: null });
  assert.equal(res.status, 200);
  const text = fs.readFileSync(path.join(dir, "jira", "notes", "PAY-77.md"), "utf8");
  assert.match(text, /jira_id: ['"]?777/);
});

test("ticket detail for a moved key reads note and groom under the canonical key", async () => {
  const orig = jira.getIssueDetail;
  jira.getIssueDetail = async () => detail("NEW-5");
  assert.equal((await put("/api/notes/NEW-5", { body: "canonical note", baseMtimeMs: null })).status, 200);
  const body = await (await fetch(base() + "/api/tickets/OLD-5")).json();
  jira.getIssueDetail = orig;
  assert.equal(body.detail.ticket.key, "NEW-5");
  assert.equal(body.note.body.trim(), "canonical note");
  assert.match(body.groomPath, /NEW-5/);
});

test("scratchpad: empty until saved, round-trips, rejects non-scenes, allows big drawings", async () => {
  const file = path.join(dir, "scratchpad.excalidraw");
  const get = async () => (await fetch(base() + "/api/scratchpad")).json() as Promise<{ scene: unknown; error: string | null }>;
  assert.deepEqual(await get(), { scene: null, error: null });
  const scene = { type: "excalidraw", version: 2, source: "x", elements: [{ id: "a" }], appState: {}, files: {} };
  assert.equal((await put("/api/scratchpad", scene)).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), scene);
  assert.deepEqual(await get(), { scene, error: null });
  assert.equal((await put("/api/scratchpad", { type: "other", elements: [] })).status, 400);
  assert.equal((await put("/api/scratchpad", { type: "excalidraw", elements: "no" })).status, 400);
  // Embedded images make scenes larger than the 1 MB limit for other bodies.
  const big = { ...scene, files: { f: { dataURL: "x".repeat(3_000_000) } } };
  assert.equal((await put("/api/scratchpad", big)).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), big);
});

test("scratchpad: a corrupt file is reported, never overwritten", async () => {
  const file = path.join(dir, "scratchpad.excalidraw");
  fs.writeFileSync(file, "{broken");
  const r = (await (await fetch(base() + "/api/scratchpad")).json()) as { scene: unknown; error: string | null };
  assert.equal(r.scene, null);
  assert.match(r.error ?? "", /scratchpad\.excalidraw/);
  const scene = { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} };
  assert.equal((await put("/api/scratchpad", scene)).status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  fs.rmSync(file);
});

// ---- reading list ----
const CONF_URL = "https://acme.example/wiki/spaces/PAY/pages/1/Retry+strategy";
const postReading = (body: unknown, headers: Record<string, string> = J) =>
  fetch(base() + "/api/reading", { method: "POST", headers, body: JSON.stringify(body) });

test("POST /api/reading adds an item, and a second POST of the same URL returns existed: true", async () => {
  const first = await postReading({ url: CONF_URL });
  assert.equal(first.status, 201);
  const a = await first.json();
  assert.equal(a.existed, false);
  assert.equal(a.item.title, "Retry strategy");
  assert.equal(a.item.status, "Pending");
  const second = await postReading({ url: `${CONF_URL}/` });
  assert.equal(second.status, 200);
  const b = await second.json();
  assert.equal(b.existed, true);
  assert.equal(b.item.id, a.item.id);
  const list = await (await fetch(base() + "/api/reading")).json();
  assert.equal(list.items.filter((i: { url: string }) => i.url === CONF_URL).length, 1);
  assert.deepEqual(list.config.statuses, ["Pending", "Open questions", "Complete"]);
  assert.equal(list.error, null);
  const bad = await postReading({ url: "ftp://x" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "Enter a link starting with http:// or https://");
});

test("POST /api/reading without the JSON content type is 415", async () => {
  const res = await postReading({ url: CONF_URL }, { "Content-Type": "text/plain" });
  assert.equal(res.status, 415);
});

async function addItem(url: string): Promise<string> {
  return (await (await postReading({ url })).json()).item.id;
}

test("PUT /api/reading/<id> sets status and tickets; a status not in reading.yaml is 400", async () => {
  const id = await addItem("https://example.com/put-fields");
  const ok = await put(`/api/reading/${id}`, { status: "Complete", tickets: ["pay-1"], category: "RFC" });
  assert.equal(ok.status, 200);
  assert.equal(typeof (await ok.json()).mtimeMs, "number");
  const item = (await (await fetch(base() + "/api/reading")).json()).items.find((i: { id: string }) => i.id === id);
  assert.equal(item.status, "Complete");
  assert.deepEqual(item.tickets, ["PAY-1"]);
  assert.equal(item.category, "RFC");
  assert.equal((await put(`/api/reading/${id}`, { status: "Nope" })).status, 400);
  assert.equal((await put(`/api/reading/${id}`, { category: "Nope" })).status, 400);
  assert.equal((await put(`/api/reading/${id}`, { tickets: ["not a key"] })).status, 400);
  assert.equal((await put("/api/reading/no-such-item", { status: "Complete" })).status, 404);
  assert.equal((await put("/api/reading/Bad%20Id", { status: "Complete" })).status, 400);
});

test("PUT /api/reading/<id>/note conflict returns 409 with current", async () => {
  const id = await addItem("https://example.com/note-conflict");
  const ok = await put(`/api/reading/${id}/note`, { body: "first", baseMtimeMs: null, force: true });
  assert.equal(ok.status, 200);
  const stale = await put(`/api/reading/${id}/note`, { body: "second", baseMtimeMs: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).current.body, "first");
});

test("DELETE /api/reading/<id> moves it to the trash; a second DELETE is 404", async () => {
  const id = await addItem("https://example.com/delete-me");
  const del = () => fetch(base() + `/api/reading/${id}`, { method: "DELETE", headers: J, body: "{}" });
  assert.equal((await del()).status, 204);
  assert.ok(!fs.existsSync(path.join(dir, "reading", "items", `${id}.md`)));
  assert.ok(fs.readdirSync(path.join(dir, ".cache", "trash", "reading")).some((n) => n.startsWith(`${id}.`)));
  assert.equal((await del()).status, 404);
});

test("GET /api/reading/<id>/copy/prompt fills url, title, tickets, groomPath and notePath", async () => {
  const id = await addItem("https://example.com/copy-me");
  await put(`/api/reading/${id}`, { tickets: ["PAY-1", "PAY-2"] });
  const text = await (await fetch(base() + `/api/reading/${id}/copy/prompt`)).text();
  assert.ok(text.includes("https://example.com/copy-me"), text);
  assert.ok(text.includes("(example.com: copy-me)"), text);
  assert.ok(text.includes("PAY-1, PAY-2"), text);
  assert.ok(text.includes(path.join(dir, "reading", "groom", `${id}.md`)), text);
  assert.ok(text.includes(path.join(dir, "reading", "items", `${id}.md`)), text);
  assert.equal(await (await fetch(base() + `/api/reading/${id}/copy/link`)).text(), "[example.com: copy-me](https://example.com/copy-me)");
  assert.equal((await fetch(base() + `/api/reading/${id}/copy/nope`)).status, 400);
});

test("GET /api/tickets/PAY-1 includes reading items that link PAY-1", async () => {
  const id = await addItem("https://example.com/linked-to-pay-1");
  await put(`/api/reading/${id}`, { tickets: ["PAY-1"] });
  const body = await (await fetch(base() + "/api/tickets/PAY-1")).json();
  assert.ok(body.reading.some((r: { id: string }) => r.id === id), JSON.stringify(body.reading));
});

test("SSE delivers a reading event when a reading item file is written", async () => {
  const ac = new AbortController();
  const res = await fetch(base() + "/api/events", { signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  setTimeout(() => fs.writeFileSync(path.join(dir, "reading", "items", "2026-10-25-sse.md"), "---\ntitle: x\n---\n"), 100);
  let buf = "";
  const want = 'data: {"type":"reading","id":"2026-10-25-sse"}';
  const deadline = Date.now() + 2000;
  while (!buf.includes(want) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    if (!r || r.done) break;
    buf += decoder.decode(r.value);
  }
  ac.abort();
  assert.ok(buf.includes(want), buf);
});
