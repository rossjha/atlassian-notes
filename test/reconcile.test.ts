import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcile } from "../src/server/reconcile.ts";
import { NotesStore } from "../src/server/notesStore.ts";
import { JiraError, type JiraClient } from "../src/server/jira.ts";
import type { Ticket } from "../src/shared/types.ts";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-"));
  const notes = new NotesStore(dir);
  const statePath = path.join(dir, ".cache", "reconcile.json");
  return { dir, notes, statePath };
}
const ticket = (id: string, key: string) => ({ id, key }) as Ticket;
function fakeJira(brief: (k: string) => Promise<{ id: string; key: string } | null>) {
  const calls: string[] = [];
  const jira = {
    search: async () => [],
    getIssueDetail: async () => { throw new Error("unused"); },
    getIssueBrief: async (k: string) => { calls.push(k); return brief(k); },
  } as JiraClient;
  return { jira, calls };
}
function countFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}
const NOW = new Date("2026-10-24T10:00:00Z");

test("renames by jira_id match without calling the API", async () => {
  const { dir, notes, statePath } = setup();
  await notes.writeNoteBody("PAY-1", "hello", { baseMtimeMs: null, jiraId: "100" });
  const { jira, calls } = fakeJira(async () => null);
  const seen = new Map([["NEW-5", ticket("100", "NEW-5")]]);
  const r = await reconcile({ jira, notes, seen, statePath, now: NOW });
  assert.deepEqual(r.renamed, [["PAY-1", "NEW-5"]]);
  assert.deepEqual(r.orphans, []);
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(notes.notePath("NEW-5")));
  assert.ok(!fs.existsSync(notes.notePath("PAY-1")));
  assert.ok(dir);
});

test("unseen note with null brief is an orphan; second run within 24h makes no call; file kept", async () => {
  const { dir, notes, statePath } = setup();
  await notes.writeNoteBody("PAY-2", "x", { baseMtimeMs: null, jiraId: "200" });
  const before = countFiles(dir);
  const { jira, calls } = fakeJira(async () => null);
  const seen = new Map<string, Ticket>();
  const r1 = await reconcile({ jira, notes, seen, statePath, now: NOW });
  assert.deepEqual(r1.orphans, ["PAY-2"]);
  assert.deepEqual(calls, ["200"]);
  const r2 = await reconcile({ jira, notes, seen, statePath, now: new Date(NOW.getTime() + 3600_000) });
  assert.deepEqual(r2.orphans, ["PAY-2"]);
  assert.equal(calls.length, 1);
  await reconcile({ jira, notes, seen, statePath, now: new Date(NOW.getTime() + 25 * 3600_000) });
  assert.equal(calls.length, 2);
  assert.ok(fs.existsSync(notes.notePath("PAY-2")));
  assert.equal(countFiles(dir), before + 1); // only the state file was added
});

test("unseen note whose brief returns the same key is not an orphan", async () => {
  const { notes, statePath } = setup();
  await notes.writeNoteBody("PAY-3", "x", { baseMtimeMs: null });
  const { jira, calls } = fakeJira(async (k) => ({ id: "300", key: k }));
  const r = await reconcile({ jira, notes, seen: new Map(), statePath, now: NOW });
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(calls, ["PAY-3"]);
});

test("brief returning a different key renames", async () => {
  const { notes, statePath } = setup();
  await notes.writeNoteBody("PAY-4", "x", { baseMtimeMs: null, jiraId: "400" });
  const { jira } = fakeJira(async () => ({ id: "400", key: "MOVED-1" }));
  const r = await reconcile({ jira, notes, seen: new Map(), statePath, now: NOW });
  assert.deepEqual(r.renamed, [["PAY-4", "MOVED-1"]]);
  assert.ok(fs.existsSync(notes.notePath("MOVED-1")));
});

test("non-404 JiraError skips the key and leaves state unchanged", async () => {
  const { notes, statePath } = setup();
  await notes.writeNoteBody("PAY-5", "x", { baseMtimeMs: null, jiraId: "500" });
  const { jira } = fakeJira(async () => { throw new JiraError(500, ["boom"]); });
  const r = await reconcile({ jira, notes, seen: new Map(), statePath, now: NOW });
  assert.deepEqual(r.orphans, []);
  assert.ok(!fs.existsSync(statePath) || !("PAY-5" in JSON.parse(fs.readFileSync(statePath, "utf8")).checked));
});

test("note and groom for the same key are reconciled once", async () => {
  const { notes, statePath } = setup();
  await notes.writeNoteBody("PAY-6", "x", { baseMtimeMs: null, jiraId: "600" });
  fs.mkdirSync(path.dirname(notes.groomPath("PAY-6")), { recursive: true });
  fs.writeFileSync(notes.groomPath("PAY-6"), "---\nkey: PAY-6\njira_id: '600'\n---\nbody\n");
  const { jira, calls } = fakeJira(async () => null);
  await reconcile({ jira, notes, seen: new Map(), statePath, now: NOW });
  assert.equal(calls.length, 1);
});
