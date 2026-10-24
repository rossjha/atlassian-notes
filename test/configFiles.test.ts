import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigFileError, ensureDataDir, loadColumns, loadViews, saveViews } from "../src/server/configFiles.ts";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test("ensureDataDir creates dirs and substitutes the project key, never overwriting", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const text = await fs.readFile(path.join(dir, "views.yaml"), "utf8");
  assert.ok(text.includes("project = PAY AND sprint in openSprints()"));
  assert.ok(!text.includes("{{PROJECT}}"));
  for (const d of ["jira/notes", "jira/groom", ".cache/views"]) {
    assert.ok((await fs.stat(path.join(dir, d))).isDirectory());
  }
  await fs.writeFile(path.join(dir, "views.yaml"), "views: []\n");
  await fs.writeFile(path.join(dir, "columns.yaml"), "custom: {}\n");
  await ensureDataDir(dir, "PAY", examples);
  assert.equal(await fs.readFile(path.join(dir, "views.yaml"), "utf8"), "views: []\n");
  assert.equal(await fs.readFile(path.join(dir, "columns.yaml"), "utf8"), "custom: {}\n");
});

test("loadViews on generated files returns the 3 example views with defaults", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  assert.equal(columns.jiraFields.sprint, "customfield_10020");
  assert.equal(columns.jiraFields.acceptanceCriteria, null);
  assert.match(columns.groomPrompt, /^Run groom-work-item on \{key\}/);
  const views = await loadViews(dir, columns);
  assert.deepEqual(views.map((v) => v.id), ["current", "next", "backlog"]);
  for (const v of views) {
    assert.equal(v.limit, 500);
    assert.deepEqual(v.filters, {});
  }
  assert.deepEqual(views[0].columns.map((c) => c.id), ["key", "summary", "status", "storyPoints", "note", "groom", "category"]);
  assert.equal(views[0].columns[4].display, "truncate");
});

test("broken views.yaml rejects with ConfigFileError naming the file", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  await fs.writeFile(path.join(dir, "views.yaml"), "views: [ {id: x");
  await assert.rejects(loadViews(dir, columns), (e: unknown) => {
    assert.ok(e instanceof ConfigFileError);
    assert.ok(e.file.endsWith("views.yaml"));
    return true;
  });
});

test("duplicate view ids and bad ids reject", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  const v = "  - {id: a, name: A, jql: x, columns: [{id: key}]}\n";
  await fs.writeFile(path.join(dir, "views.yaml"), `views:\n${v}${v}`);
  await assert.rejects(loadViews(dir, columns), ConfigFileError);
  await fs.writeFile(path.join(dir, "views.yaml"), `views:\n  - {id: Bad_Id, name: A, jql: x, columns: []}\n`);
  await assert.rejects(loadViews(dir, columns), ConfigFileError);
});

test("custom column clashing with a builtin rejects on columns.yaml", async () => {
  await fs.writeFile(path.join(dir, "columns.yaml"), "custom:\n  status:\n    label: S\n    type: text\n");
  await assert.rejects(loadColumns(dir), (e: unknown) => {
    assert.ok(e instanceof ConfigFileError);
    assert.ok(e.file.endsWith("columns.yaml"));
    return true;
  });
});

test("unknown column ids are dropped with a warning; unknown filter keys reject", async (t) => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  const warn = t.mock.method(console, "warn", () => {});
  await fs.writeFile(path.join(dir, "views.yaml"), "views:\n  - {id: a, name: A, jql: x, columns: [{id: key}, {id: nope}]}\n");
  const views = await loadViews(dir, columns);
  assert.deepEqual(views[0].columns, [{ id: "key" }]);
  assert.equal(warn.mock.callCount(), 1);
  await fs.writeFile(
    path.join(dir, "views.yaml"),
    "views:\n  - {id: a, name: A, jql: x, columns: [], filters: {status: {op: empty}}}\n",
  );
  await assert.rejects(loadViews(dir, columns), ConfigFileError);
});

test("saveViews then loadViews round-trips", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  const views = [
    {
      id: "one",
      name: "One",
      jql: "project = PAY ORDER BY rank",
      limit: 100,
      columns: [{ id: "key" }, { id: "note", display: "expand" as const }, { id: "category", hidden: true }],
      filters: {
        category: { op: "oneOf" as const, values: ["Tech debt"] },
        ownerGuess: { op: "contains" as const, text: "sam" },
      },
    },
  ];
  await saveViews(dir, views);
  assert.deepEqual(await loadViews(dir, columns), views);
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes(".tmp-")), []);
});

test("prototype property names are not treated as custom columns", async (t) => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  t.mock.method(console, "warn", () => {});
  await fs.writeFile(path.join(dir, "views.yaml"), "views:\n  - {id: a, name: A, jql: x, columns: [{id: key}, {id: constructor}]}\n");
  assert.deepEqual((await loadViews(dir, columns))[0].columns, [{ id: "key" }]);
  await fs.writeFile(
    path.join(dir, "views.yaml"),
    "views:\n  - {id: a, name: A, jql: x, columns: [], filters: {toString: {op: empty}}}\n",
  );
  await assert.rejects(loadViews(dir, columns), ConfigFileError);
  await fs.writeFile(path.join(dir, "columns.yaml"), "custom:\n  __proto__:\n    label: P\n    type: text\n");
  await assert.rejects(loadColumns(dir), ConfigFileError);
});
