import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotesStore, atomicWrite, keepTmpFilesUnder, tmpPathFor } from "../src/server/notesStore.ts";
import { InvalidKeyError, parseFrontMatter } from "../src/server/frontMatter.ts";

let dir: string;
let store: NotesStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-"));
  store = new NotesStore(dir);
});
afterEach(async () => {
  keepTmpFilesUnder(null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("writeNoteBody creates a new note with identity front matter", async () => {
  const r = await store.writeNoteBody("PAY-1", "hi", { baseMtimeMs: null, jiraId: "100" });
  assert.equal(r.ok, true);
  const raw = await fs.readFile(path.join(dir, "jira/notes/PAY-1.md"), "utf8");
  const doc = parseFrontMatter(raw);
  assert.deepEqual(doc.data, { key: "PAY-1", jira_id: "100" });
  assert.equal(doc.body, "hi");
  const note = await store.readNote("PAY-1");
  assert.equal(note?.body, "hi");
});

test("readNote returns null when missing", async () => {
  assert.equal(await store.readNote("PAY-9"), null);
});

test("stale base mtime gives conflict, file untouched; force succeeds", async () => {
  const first = await store.writeNoteBody("PAY-1", "mine", { baseMtimeMs: null });
  assert.ok(first.ok);
  const p = store.notePath("PAY-1");
  await fs.writeFile(p, "external");
  const future = new Date(Date.now() + 5000);
  await fs.utimes(p, future, future);
  const r = await store.writeNoteBody("PAY-1", "later", { baseMtimeMs: first.mtimeMs });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === "conflict");
  assert.equal(!r.ok && r.conflict?.body, "external");
  assert.equal(await fs.readFile(p, "utf8"), "external");
  const forced = await store.writeNoteBody("PAY-1", "later", { baseMtimeMs: first.mtimeMs, force: true });
  assert.equal(forced.ok, true);
  assert.equal((await store.readNote("PAY-1"))?.body, "later");
});

test("save with a base mtime after the file was deleted on disk conflicts and recreates nothing", async () => {
  const first = await store.writeNoteBody("PAY-1", "mine", { baseMtimeMs: null });
  assert.ok(first.ok);
  await fs.rm(store.notePath("PAY-1"));
  const r = await store.writeNoteBody("PAY-1", "later", { baseMtimeMs: first.mtimeMs });
  assert.ok(!r.ok && r.reason === "conflict");
  assert.equal(!r.ok && r.conflict, null);
  assert.equal(await store.readNote("PAY-1"), null);
  const forced = await store.writeNoteBody("PAY-1", "later", { baseMtimeMs: first.mtimeMs, force: true });
  assert.equal(forced.ok, true);
  assert.equal((await store.readNote("PAY-1"))?.body, "later");
});

test("concurrent atomicWrite calls to the same file all succeed and leave no tmp files", async () => {
  const file = path.join(dir, "views.yaml");
  const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => atomicWrite(file, `v${i}\n`)));
  assert.deepEqual(results.filter((r) => r.status === "rejected"), []);
  assert.match(await fs.readFile(file, "utf8"), /^v\d+\n$/);
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes(".tmp-")), []);
});

test("atomicWrite removes its tmp file when the rename fails", async () => {
  const target = path.join(dir, "adir");
  await fs.mkdir(path.join(target, "child"), { recursive: true });
  await assert.rejects(atomicWrite(target, "x"));
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes(".tmp-")), []);
});

test("tmp files for the notes folder go under .cache/tmp, out of Obsidian's sight", () => {
  keepTmpFilesUnder("/n");
  assert.match(tmpPathFor("/n/jira/notes/PAY-1.md"), /^\/n\/\.cache\/tmp\/PAY-1\.md\.tmp-/);
  assert.match(tmpPathFor("/n/views.yaml"), /^\/n\/\.cache\/tmp\/views\.yaml\.tmp-/);
  assert.match(tmpPathFor("/n/.cache/views/a.json"), /^\/n\/\.cache\/tmp\/a\.json\.tmp-/);
});

test("tmp files outside the notes folder (or with none set) sit beside the file", () => {
  assert.match(tmpPathFor("/n/views.yaml"), /^\/n\/views\.yaml\.tmp-/);
  keepTmpFilesUnder("/n");
  assert.match(tmpPathFor("/other/x.json"), /^\/other\/x\.json\.tmp-/);
  assert.match(tmpPathFor("/notes-elsewhere/x.json"), /^\/notes-elsewhere\/x\.json\.tmp-/);
});

test("with a notes folder set, atomicWrite leaves no tmp files in the target folder or .cache/tmp", async () => {
  keepTmpFilesUnder(dir);
  const file = path.join(dir, "jira", "notes", "PAY-1.md");
  await Promise.all(Array.from({ length: 8 }, (_, i) => atomicWrite(file, `v${i}\n`)));
  assert.match(await fs.readFile(file, "utf8"), /^v\d\n$/);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["PAY-1.md"]);
  assert.deepEqual(await fs.readdir(path.join(dir, ".cache", "tmp")), []);
  const target = path.join(dir, "adir");
  await fs.mkdir(path.join(target, "child"), { recursive: true });
  await assert.rejects(atomicWrite(target, "x"));
  assert.deepEqual(await fs.readdir(path.join(dir, ".cache", "tmp")), []);
});

test("null base mtime with existing file conflicts", async () => {
  await store.writeNoteBody("PAY-1", "a", { baseMtimeMs: null });
  const r = await store.writeNoteBody("PAY-1", "b", { baseMtimeMs: null });
  assert.ok(!r.ok && r.reason === "conflict");
});

test("setNoteField preserves body byte for byte and null removes the key", async () => {
  const body = "line1\n\n- [ ] x\n  trailing  \n";
  await store.writeNoteBody("PAY-1", body, { baseMtimeMs: null, jiraId: "100" });
  const r = await store.setNoteField("PAY-1", "category", "Tech debt");
  assert.ok(r.ok);
  const note = await store.readNote("PAY-1");
  assert.equal(note?.body, body);
  assert.equal(note?.data.category, "Tech debt");
  assert.equal(note?.data.key, "PAY-1");
  await store.setNoteField("PAY-1", "category", null);
  const after = await store.readNote("PAY-1");
  assert.equal("category" in (after?.data ?? {}), false);
  assert.equal(after?.body, body);
});

test("setNoteField creates the note when missing", async () => {
  const r = await store.setNoteField("PAY-2", "category", "Bug", "200");
  assert.ok(r.ok);
  const note = await store.readNote("PAY-2");
  assert.equal(note?.data.category, "Bug");
  assert.equal(note?.data.jira_id, "200");
  assert.equal(note?.body, "");
});

test("setNoteField refuses broken front matter and leaves file alone", async () => {
  const p = store.notePath("PAY-1");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const text = "---\nkey: [unclosed\n---\nbody";
  await fs.writeFile(p, text);
  const r = await store.setNoteField("PAY-1", "category", "X");
  assert.ok(!r.ok && r.reason === "parse-error");
  assert.equal(await fs.readFile(p, "utf8"), text);
});

test("invalid keys reject and create nothing outside notesDir", async () => {
  const bad = "../X-1";
  await assert.rejects(store.readNote(bad), InvalidKeyError);
  await assert.rejects(store.readGroom(bad), InvalidKeyError);
  await assert.rejects(store.writeNoteBody(bad, "x", { baseMtimeMs: null }), InvalidKeyError);
  await assert.rejects(store.setNoteField(bad, "f", "v"), InvalidKeyError);
  await assert.rejects(store.ensureIdentity(bad, "1"), InvalidKeyError);
  await assert.rejects(store.renameKey(bad, "A-1"), InvalidKeyError);
  await assert.rejects(store.renameKey("A-1", bad), InvalidKeyError);
  assert.throws(() => store.notePath(bad), InvalidKeyError);
  assert.throws(() => store.groomPath(bad), InvalidKeyError);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.deepEqual(await fs.readdir(path.dirname(dir)).then((l) => l.filter((n) => n === "X-1.md")), []);
});

test("readGroom uses front matter values", async () => {
  const p = store.groomPath("PAY-1");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, "---\nreadiness: ready\nsummary: Good to go\ngroomed_at: 2026-10-01T10:00:00.000Z\n---\n# Body\n");
  const g = await store.readGroom("PAY-1");
  assert.deepEqual(g?.summary, { readiness: "ready", summary: "Good to go", groomedAt: "2026-10-01T10:00:00.000Z" });
});

test("readGroom derives summary and groomedAt without front matter", async () => {
  const p = store.groomPath("PAY-1");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, "\n# Verdict: ready\nmore");
  const g = await store.readGroom("PAY-1");
  assert.equal(g?.summary.summary, "Verdict: ready");
  assert.equal(g?.summary.readiness, null);
  assert.equal(g?.summary.groomedAt, new Date(g!.mtimeMs).toISOString());
});

test("ensureIdentity adds key/jira_id keeping body, is idempotent, skips parse errors", async () => {
  const p = store.groomPath("PAY-1");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const body = "# Verdict\n  keep  \n";
  await fs.writeFile(p, body);
  await store.ensureIdentity("PAY-1", "100");
  const g = await store.readGroom("PAY-1");
  assert.equal(g?.data.key, "PAY-1");
  assert.equal(g?.data.jira_id, "100");
  assert.equal(g?.body, body);

  const old = new Date(Date.now() - 60000);
  await fs.utimes(p, old, old);
  const before = (await fs.stat(p)).mtimeMs;
  await store.ensureIdentity("PAY-1", "100");
  assert.equal((await fs.stat(p)).mtimeMs, before);

  const np = store.notePath("PAY-1");
  await fs.mkdir(path.dirname(np), { recursive: true });
  const broken = "---\nkey: [x\n---\nb";
  await fs.writeFile(np, broken);
  await store.ensureIdentity("PAY-1", "100");
  assert.equal(await fs.readFile(np, "utf8"), broken);
});

test("ensureIdentity does nothing when no files exist", async () => {
  await store.ensureIdentity("PAY-1", "100");
  assert.deepEqual(await fs.readdir(dir), []);
});

test("renameKey moves notes and groom files and updates key", async () => {
  await store.writeNoteBody("PAY-1", "n", { baseMtimeMs: null, jiraId: "100" });
  const gp = store.groomPath("PAY-1");
  await fs.mkdir(path.dirname(gp), { recursive: true });
  await fs.writeFile(gp, "g body");
  assert.equal(await store.renameKey("PAY-1", "NEW-5"), "renamed");
  assert.equal(await store.readNote("PAY-1"), null);
  assert.equal(await store.readGroom("PAY-1"), null);
  const n = await store.readNote("NEW-5");
  assert.equal(n?.data.key, "NEW-5");
  assert.equal(n?.body, "n");
  const g = await store.readGroom("NEW-5");
  assert.equal(g?.data.key, "NEW-5");
  assert.equal(g?.body, "g body");
});

test("renameKey reports target-exists and missing", async () => {
  await store.writeNoteBody("PAY-1", "a", { baseMtimeMs: null });
  await store.writeNoteBody("NEW-5", "b", { baseMtimeMs: null });
  assert.equal(await store.renameKey("PAY-1", "NEW-5"), "target-exists");
  assert.equal((await store.readNote("PAY-1"))?.body, "a");
  assert.equal((await store.readNote("NEW-5"))?.body, "b");
  assert.equal(await store.renameKey("ZZ-1", "ZZ-2"), "missing");
});

test("listAll lists valid keys and ignores stray and tmp files", async () => {
  await store.writeNoteBody("PAY-1", "a", { baseMtimeMs: null });
  const gp = store.groomPath("PAY-2");
  await fs.mkdir(path.dirname(gp), { recursive: true });
  await fs.writeFile(gp, "# hi");
  const nd = path.dirname(store.notePath("PAY-1"));
  await fs.writeFile(path.join(nd, "junk.md"), "x");
  await fs.writeFile(path.join(nd, "PAY-3.md.tmp-123"), "x");
  await fs.writeFile(path.join(nd, "notes.txt"), "x");
  const all = await store.listAll();
  assert.deepEqual(all.notes.map((n) => n.key), ["PAY-1"]);
  assert.deepEqual(all.grooms.map((n) => n.key), ["PAY-2"]);
});

test("listAll on empty dir returns empty lists", async () => {
  assert.deepEqual(await store.listAll(), { notes: [], grooms: [] });
});

test("setNoteField refuses a comments-only front matter block and leaves the file byte-identical", async () => {
  const p = store.notePath("PAY-3");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const text = "---\n# keep me\n---\nbody\n";
  await fs.writeFile(p, text);
  const r = await store.setNoteField("PAY-3", "category", "a");
  assert.ok(!r.ok && r.reason === "parse-error");
  await store.ensureIdentity("PAY-3", "103");
  assert.equal(await fs.readFile(p, "utf8"), text);
});
