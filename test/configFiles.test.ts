import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigFileError, DEFAULT_READING_CONFIG, ensureDataDir, loadAnalysis, loadColumns, loadReadingConfig, loadViews, saveViews } from "../src/server/configFiles.ts";

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

test("ensureDataDir creates board.yaml and keeps edits", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const text = await fs.readFile(path.join(dir, "board.yaml"), "utf8");
  assert.match(text, /^columns: \[Backlog, Doing, PEN, Done\]/);
  await fs.writeFile(path.join(dir, "board.yaml"), "columns: [X]\n");
  await ensureDataDir(dir, "PAY", examples);
  assert.equal(await fs.readFile(path.join(dir, "board.yaml"), "utf8"), "columns: [X]\n");
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

test("unknown column ids and filter keys are dropped with a warning", async (t) => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  const warn = t.mock.method(console, "warn", () => {});
  await fs.writeFile(path.join(dir, "views.yaml"), "views:\n  - {id: a, name: A, jql: x, columns: [{id: key}, {id: nope}]}\n");
  const views = await loadViews(dir, columns);
  assert.deepEqual(views[0].columns, [{ id: "key" }]);
  assert.equal(warn.mock.callCount(), 1);
  await fs.writeFile(
    path.join(dir, "views.yaml"),
    "views:\n  - {id: a, name: A, jql: x, columns: [], filters: {status: {op: empty}, renamedAway: {op: oneOf, values: [x]}}}\n",
  );
  assert.deepEqual((await loadViews(dir, columns))[0].filters, {});
  assert.equal(warn.mock.callCount(), 3);
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
  assert.deepEqual((await loadViews(dir, columns))[0].filters, {});
  await fs.writeFile(path.join(dir, "columns.yaml"), "custom:\n  __proto__:\n    label: P\n    type: text\n");
  await assert.rejects(loadColumns(dir), ConfigFileError);
});

test("column widths round-trip through saveViews/loadViews", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  const views = [
    {
      id: "w",
      name: "W",
      jql: "x",
      limit: 10,
      columns: [{ id: "key", width: 40 }, { id: "note", display: "expand" as const, width: 320 }, { id: "summary" }],
      filters: {},
    },
  ];
  await saveViews(dir, views);
  assert.match(await fs.readFile(path.join(dir, "views.yaml"), "utf8"), /width: 320/);
  assert.deepEqual(await loadViews(dir, columns), views);
});

test("invalid column widths are dropped with a warning, keeping the column", async (t) => {
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  const warn = t.mock.method(console, "warn", () => {});
  await fs.writeFile(
    path.join(dir, "views.yaml"),
    "views:\n  - {id: a, name: A, jql: x, columns: [{id: key, width: wide}, {id: summary, width: 10}, {id: status, width: 5000}, {id: type, width: -3}, {id: note, width: 200.6}, {id: groom, width: .nan}]}\n",
  );
  const views = await loadViews(dir, columns);
  assert.deepEqual(views[0].columns, [
    { id: "key" },
    { id: "summary" },
    { id: "status" },
    { id: "type" },
    { id: "note", width: 201 },
    { id: "groom" },
  ]);
  assert.equal(warn.mock.callCount(), 5);
});

test("ensureDataDir creates reading.yaml from the example and the reading folders", async () => {
  await ensureDataDir(dir, "PAY", examples);
  for (const d of ["reading/items", "reading/groom"]) assert.ok((await fs.stat(path.join(dir, d))).isDirectory());
  const cfg = await loadReadingConfig(dir);
  assert.deepEqual(cfg.statuses, ["Pending", "Open questions", "Complete"]);
  assert.equal(cfg.doneStatus, "Complete");
  assert.deepEqual(cfg.categories, ["Architecture", "RFC", "Discussion", "Learning"]);
  assert.equal(cfg.prompts.length, 5);
  assert.ok(cfg.groomPrompt.includes("{groomPath}"));
});

test("loadReadingConfig: missing file gives the defaults", async () => {
  const cfg = await loadReadingConfig(dir);
  assert.deepEqual(cfg, DEFAULT_READING_CONFIG);
  assert.deepEqual(cfg.statuses, ["Pending", "Open questions", "Complete"]);
  assert.equal(cfg.doneStatus, "Complete");
});

test("loadReadingConfig: doneStatus must be one of statuses", async () => {
  await fs.writeFile(path.join(dir, "reading.yaml"), "statuses: [Pending, Done]\ndoneStatus: Complete\n");
  await assert.rejects(loadReadingConfig(dir), (e: unknown) => e instanceof ConfigFileError && /doneStatus/.test((e as Error).message));
});

test("loadReadingConfig: statuses must be a non-empty list of unique non-empty strings", async () => {
  for (const bad of ["statuses: []\n", "statuses: [A, A]\n", "statuses: [A, '']\n", "statuses: nope\n"]) {
    await fs.writeFile(path.join(dir, "reading.yaml"), bad);
    await assert.rejects(loadReadingConfig(dir), (e: unknown) => e instanceof ConfigFileError && /statuses/.test((e as Error).message), bad);
  }
});

test("loadReadingConfig: doneStatus defaults to the last status; categories and prompts default to []; groomPrompt to the default", async () => {
  await fs.writeFile(path.join(dir, "reading.yaml"), "statuses: [Todo, Done]\n");
  const cfg = await loadReadingConfig(dir);
  assert.equal(cfg.doneStatus, "Done");
  assert.deepEqual(cfg.categories, []);
  assert.deepEqual(cfg.prompts, []);
  assert.equal(cfg.groomPrompt, DEFAULT_READING_CONFIG.groomPrompt);
});

test("a view's keyword search round-trips; blank or non-string is dropped", async (t) => {
  t.mock.method(console, "warn", () => {});
  await ensureDataDir(dir, "PAY", examples);
  const columns = await loadColumns(dir);
  const base = { name: "V", jql: "project = PAY", limit: 50, columns: [], filters: {} };
  await saveViews(dir, [{ id: "a", ...base, search: "auth" }]);
  assert.equal((await loadViews(dir, columns))[0]!.search, "auth");
  await fs.writeFile(path.join(dir, "views.yaml"), "views:\n  - {id: a, name: V, jql: x, search: '  '}\n  - {id: b, name: V, jql: x, search: 3}\n");
  const loaded = await loadViews(dir, columns);
  assert.equal("search" in loaded[0]!, false);
  assert.equal("search" in loaded[1]!, false);
});

test("loadAnalysis: missing is null, valid parses, broken names the file", async () => {
  assert.equal(await loadAnalysis(dir), null);
  await fs.writeFile(path.join(dir, "analysis.yaml"), "settings:\n  stalledDays: 5\nviews:\n  current:\n    charts: [headlines]\n");
  const a = (await loadAnalysis(dir))!;
  assert.equal(a.settings.stalledDays, 5);
  assert.deepEqual(a.views.current!.charts, [{ type: "headlines" }]);
  await fs.writeFile(path.join(dir, "analysis.yaml"), "views:\n  current:\n    charts: [pie]\n");
  await assert.rejects(loadAnalysis(dir), (e: unknown) => e instanceof ConfigFileError && /analysis\.yaml/.test(e.message) && /pie/.test(e.message));
  await fs.writeFile(path.join(dir, "analysis.yaml"), "views: [\n");
  await assert.rejects(loadAnalysis(dir), (e: unknown) => e instanceof ConfigFileError && /analysis\.yaml/.test(e.message));
});

test("examples/analysis.example.yaml parses", async () => {
  await fs.copyFile(path.join(examples, "analysis.example.yaml"), path.join(dir, "analysis.yaml"));
  const a = (await loadAnalysis(dir))!;
  assert.ok(Object.keys(a.groups).length > 0);
  assert.ok(Object.keys(a.views).length > 0);
});
