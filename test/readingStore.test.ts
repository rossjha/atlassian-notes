import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InvalidUrlError, ReadingStore } from "../src/server/readingStore.ts";
import { InvalidKeyError } from "../src/server/frontMatter.ts";

const CONF = "https://acme.atlassian.net/wiki/spaces/PAY/pages/123/Retry+strategy+for+card+captures";
const ID = "2026-10-25-retry-strategy-for-card-captures";
const now = new Date("2026-10-25T10:02:00Z");
const opts = { jiraBaseUrl: "https://acme.atlassian.net", defaultStatus: "Pending", now };

let dir: string;
let store: ReadingStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-"));
  store = new ReadingStore(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const itemFile = (id: string) => path.join(dir, "reading", "items", `${id}.md`);
const groomFile = (id: string) => path.join(dir, "reading", "groom", `${id}.md`);
const mtime = async (f: string) => (await fs.stat(f)).mtimeMs;

test("add creates items/<id>.md with guessed title, default status, tickets [] and links []", async () => {
  const { item, existed } = await store.add(CONF, opts);
  assert.equal(existed, false);
  assert.equal(item.id, ID);
  assert.equal(item.title, "Retry strategy for card captures");
  assert.equal(item.source, "confluence");
  assert.equal(
    await fs.readFile(itemFile(ID), "utf8"),
    [
      "---",
      `id: ${ID}`,
      `url: ${CONF}`,
      "title: Retry strategy for card captures",
      "status: Pending",
      "tickets: []",
      "links: []",
      "source: confluence",
      "created: 2026-10-25T10:02:00.000Z",
      "---",
      "",
    ].join("\n"),
  );
});

test("add with the same URL written differently returns the existing item with existed: true and writes nothing", async () => {
  await store.add(CONF, opts);
  const before = await mtime(itemFile(ID));
  const again = await store.add(`  ${CONF.replace("acme.atlassian.net", "ACME.atlassian.net")}/ `, { ...opts, now: new Date("2026-10-26T00:00:00Z") });
  assert.equal(again.existed, true);
  assert.equal(again.item.id, ID);
  assert.equal(await mtime(itemFile(ID)), before);
  assert.equal((await store.list()).length, 1);
});

test("add rejects javascript: and ftp: URLs with InvalidUrlError", async () => {
  await assert.rejects(store.add("javascript:alert(1)", opts), InvalidUrlError);
  await assert.rejects(store.add("ftp://x", opts), InvalidUrlError);
});

test("setFields regenerates links from tickets, upper-cases keys, and keeps the body byte-for-byte", async () => {
  await store.add(CONF, opts);
  const w = await store.writeNote(ID, "My *note*\n\n- [ ] todo\n", { baseMtimeMs: null, force: true });
  assert.equal(w.ok, true);
  const r = await store.setFields(ID, { tickets: ["pay-40", "PAY-412"], status: "Complete", title: "Retry strategy" });
  assert.equal(r.ok, true);
  const text = await fs.readFile(itemFile(ID), "utf8");
  assert.ok(text.includes("tickets:\n  - PAY-40\n  - PAY-412\n"), text);
  assert.ok(text.includes('  - "[[jira/tickets/PAY-40|PAY-40]]"'), text);
  assert.ok(text.endsWith("---\nMy *note*\n\n- [ ] todo\n"), text);
  const item = await store.read(ID);
  assert.deepEqual(item?.tickets, ["PAY-40", "PAY-412"]);
  assert.equal(item?.status, "Complete");
  assert.equal(item?.title, "Retry strategy");
  assert.equal(item?.id, ID, "the id never follows the title");
});

test("setFields with category null removes the category key", async () => {
  await store.add(CONF, opts);
  await store.setFields(ID, { category: "RFC" });
  assert.equal((await store.read(ID))?.category, "RFC");
  await store.setFields(ID, { category: null });
  assert.equal((await store.read(ID))?.category, null);
  assert.ok(!(await fs.readFile(itemFile(ID), "utf8")).includes("category"));
});

test("setFields rejects an invalid ticket key with InvalidKeyError and leaves the file unchanged", async () => {
  await store.add(CONF, opts);
  const before = await fs.readFile(itemFile(ID), "utf8");
  await assert.rejects(store.setFields(ID, { tickets: ["not a key"] }), InvalidKeyError);
  assert.equal(await fs.readFile(itemFile(ID), "utf8"), before);
});

test("writeNote with a stale baseMtimeMs returns conflict with the current file; force overwrites; fields are kept", async () => {
  await store.add(CONF, opts);
  await store.setFields(ID, { status: "Complete" });
  const stale = await store.writeNote(ID, "mine", { baseMtimeMs: 1 });
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.reason === "conflict" && stale.conflict !== null);
  const forced = await store.writeNote(ID, "mine", { baseMtimeMs: 1, force: true });
  assert.equal(forced.ok, true);
  const item = await store.read(ID);
  assert.equal(item?.note, "mine");
  assert.equal(item?.status, "Complete");
});

test("a field write between two note saves is not lost", async () => {
  await store.add(CONF, opts);
  const first = await store.writeNote(ID, "A", { baseMtimeMs: (await store.read(ID))!.mtimeMs });
  assert.ok(first.ok);
  const fields = await store.setFields(ID, { status: "Open questions" });
  assert.ok(fields.ok);
  const second = await store.writeNote(ID, "B", { baseMtimeMs: fields.mtimeMs });
  assert.ok(second.ok);
  const item = await store.read(ID);
  assert.equal(item?.note, "B");
  assert.equal(item?.status, "Open questions");
});

test("a hand-broken front matter lists with parseError, and setFields/writeNote return parse-error without touching the file", async () => {
  await fs.mkdir(path.dirname(itemFile("2026-10-01-broken")), { recursive: true });
  const broken = "---\ntitle: [unclosed\n---\nbody\n";
  await fs.writeFile(itemFile("2026-10-01-broken"), broken);
  const [item] = await store.list();
  assert.equal(item.id, "2026-10-01-broken");
  assert.equal(item.title, "2026-10-01-broken");
  assert.ok(item.parseError);
  const f = await store.setFields(item.id, { status: "Complete" });
  assert.ok(!f.ok && f.reason === "parse-error");
  const n = await store.writeNote(item.id, "x", { baseMtimeMs: item.mtimeMs });
  assert.ok(!n.ok && n.reason === "parse-error");
  assert.equal(await fs.readFile(itemFile(item.id), "utf8"), broken);
});

test("list reads groom summary and groomedAt from reading/groom/<id>.md", async () => {
  await store.add(CONF, opts);
  await fs.mkdir(path.dirname(groomFile(ID)), { recursive: true });
  await fs.writeFile(groomFile(ID), "---\nsummary: 3 key ideas\ngroomed_at: 2026-10-25T12:00:00Z\n---\n# Summary\n");
  const [item] = await store.list();
  assert.deepEqual(item.groom, { summary: "3 key ideas", groomedAt: "2026-10-25T12:00:00.000Z" });
  await fs.writeFile(groomFile(ID), "\n## First line wins\nmore\n");
  assert.equal((await store.read(ID))?.groom?.summary, "First line wins");
});

test("remove moves item and groom files under .cache/trash/reading and list no longer shows it", async () => {
  await store.add(CONF, opts);
  await fs.mkdir(path.dirname(groomFile(ID)), { recursive: true });
  await fs.writeFile(groomFile(ID), "g");
  assert.equal(await store.remove(ID), true);
  assert.deepEqual(await store.list(), []);
  const trash = await fs.readdir(path.join(dir, ".cache", "trash", "reading"));
  assert.equal(trash.length, 2);
  assert.ok(trash.some((n) => n.startsWith(`${ID}.`)) && trash.some((n) => n.startsWith(`${ID}-groom.`)), trash.join(","));
  assert.equal(await store.remove(ID), false);
});

test("renameTicketKey rewrites tickets and links only in items that reference the old key; body unchanged; returns their ids", async () => {
  const a = (await store.add("https://example.com/a", opts)).item.id;
  const b = (await store.add("https://example.com/b", opts)).item.id;
  await store.setFields(a, { tickets: ["PAY-1", "PAY-2"] });
  await store.setFields(b, { tickets: ["PAY-3"] });
  await store.writeNote(a, "keep me\n", { baseMtimeMs: null, force: true });
  const bBefore = await fs.readFile(itemFile(b), "utf8");
  assert.deepEqual(await store.renameTicketKey("PAY-1", "NEW-9"), [a]);
  const item = await store.read(a);
  assert.deepEqual(item?.tickets, ["NEW-9", "PAY-2"]);
  assert.equal(item?.note, "keep me\n");
  assert.ok((await fs.readFile(itemFile(a), "utf8")).includes("[[jira/tickets/NEW-9|NEW-9]]"));
  assert.equal(await fs.readFile(itemFile(b), "utf8"), bBefore);
});

test("renameTicketKey skips a file with a parse error", async () => {
  await fs.mkdir(path.dirname(itemFile("2026-10-01-broken")), { recursive: true });
  const broken = "---\ntickets: [PAY-1\n---\n";
  await fs.writeFile(itemFile("2026-10-01-broken"), broken);
  assert.deepEqual(await store.renameTicketKey("PAY-1", "NEW-9"), []);
  assert.equal(await fs.readFile(itemFile("2026-10-01-broken"), "utf8"), broken);
});

test("ticketIndex maps PAY-40 to the two items that link it", async () => {
  const a = (await store.add("https://example.com/zeta", opts)).item.id;
  const b = (await store.add("https://example.com/alpha", opts)).item.id;
  const c = (await store.add("https://example.com/other", opts)).item.id;
  await store.setFields(a, { tickets: ["PAY-40"] });
  await store.setFields(b, { tickets: ["PAY-40", "PAY-41"] });
  await store.setFields(c, { tickets: ["PAY-41"] });
  const idx = await store.ticketIndex();
  assert.deepEqual(idx.get("PAY-40")?.map((s) => s.title), ["example.com: alpha", "example.com: zeta"]);
  assert.deepEqual(idx.get("PAY-41")?.map((s) => s.id), [b, c]);
});
