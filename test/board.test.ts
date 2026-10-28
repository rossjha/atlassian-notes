import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigFileError, ensureDataDir } from "../src/server/configFiles.ts";
import {
  BoardOpError,
  applyBoardOp,
  boardKeys,
  loadBoard,
  parseBoard,
  renameInBoard,
  serialiseBoard,
  updateBoard,
} from "../src/server/board.ts";
import { eventForPath } from "../src/server/watcher.ts";
import type { BoardFile } from "../src/shared/types.ts";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sample = (): BoardFile => ({
  columns: ["Backlog", "Doing", "Done"],
  archiveColumn: "Done",
  noteColumn: "Doing",
  cards: { Backlog: [], Doing: ["A-1", "B-2"], Done: ["C-3"] },
});

test("parseBoard on the example gives 4 empty columns", async () => {
  const text = await fs.readFile(path.join(examples, "board.example.yaml"), "utf8");
  const b = parseBoard(text, "board.yaml");
  assert.equal(b.columns.length, 4);
  assert.equal(b.archiveColumn, "Done");
  for (const c of b.columns) assert.deepEqual(b.cards[c], []);
});

test("parseBoard noteColumn defaults to Doing, else the first column, and must exist", () => {
  assert.equal(parseBoard("columns: [Backlog, Doing, Done]\n", "board.yaml").noteColumn, "Doing");
  assert.equal(parseBoard("columns: [A, B]\n", "board.yaml").noteColumn, "A");
  assert.equal(parseBoard("columns: [A, B]\nnoteColumn: B\n", "board.yaml").noteColumn, "B");
  assert.throws(
    () => parseBoard("columns: [A, B]\nnoteColumn: Nope\n", "/x/board.yaml"),
    (e: unknown) => e instanceof ConfigFileError && /noteColumn/.test(e.message),
  );
});

test("parseBoard normalises cards", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const b = parseBoard(
    "columns: [Backlog, Doing, Done]\ncards:\n  Doing: [A-1, B-2]\n  Old: [C-3]\n  Done: [A-1, bad key]\n",
    "board.yaml",
  );
  assert.deepEqual(b.cards, { Backlog: ["C-3"], Doing: ["A-1", "B-2"], Done: [] });
  assert.equal(b.archiveColumn, "Done");
  assert.equal(warn.mock.callCount(), 1);
});

test("parseBoard rejects bad files with ConfigFileError", () => {
  for (const text of [
    "columns: [a, b",
    "columns: []\n",
    "cards: {}\n",
    "columns: [1, 2]\n",
    "columns: [A, A]\n",
    "columns: [A, B]\narchiveColumn: Nope\n",
    "columns: [A, B]\nnoteColumn: Nope\n",
  ]) {
    assert.throws(
      () => parseBoard(text, "/x/board.yaml"),
      (e: unknown) => e instanceof ConfigFileError && e.file.endsWith("board.yaml"),
      text,
    );
  }
});

test("serialiseBoard round-trips with flow-style columns", () => {
  const b = sample();
  const text = serialiseBoard(b);
  assert.match(text, /^columns: \[Backlog, Doing, Done\]\narchiveColumn: Done\nnoteColumn: Doing\ncards:/);
  assert.deepEqual(parseBoard(text, "board.yaml"), b);
  assert.deepEqual(boardKeys(b), ["A-1", "B-2", "C-3"]);
});

test("applyBoardOp", () => {
  const b = sample();
  const added = applyBoardOp(b, { op: "add", key: "D-4" });
  assert.deepEqual(added.cards.Backlog, ["D-4"]);
  assert.deepEqual(b.cards.Backlog, []);
  assert.deepEqual(applyBoardOp(added, { op: "add", key: "D-4" }), added);
  assert.deepEqual(applyBoardOp(added, { op: "add", key: "A-1" }), added);

  const moved = applyBoardOp(b, { op: "move", key: "B-2", column: "Done", index: 0 });
  assert.deepEqual(moved.cards.Done, ["B-2", "C-3"]);
  assert.deepEqual(moved.cards.Doing, ["A-1"]);
  assert.deepEqual(applyBoardOp(b, { op: "move", key: "A-1", column: "Done", index: 99 }).cards.Done, ["C-3", "A-1"]);
  assert.deepEqual(applyBoardOp(b, { op: "move", key: "Z-9", column: "Backlog", index: 0 }).cards.Backlog, ["Z-9"]);
  assert.deepEqual(applyBoardOp(b, { op: "move", key: "A-1", column: "Doing", index: -5 }).cards.Doing, ["A-1", "B-2"]);

  assert.deepEqual(applyBoardOp(b, { op: "remove", key: "A-1" }).cards.Doing, ["B-2"]);
  assert.deepEqual(applyBoardOp(b, { op: "remove", key: "Q-1" }), b);
  assert.deepEqual(applyBoardOp(b, { op: "archive" }).cards.Done, []);

  assert.throws(() => applyBoardOp(b, { op: "move", key: "A-1", column: "Nope", index: 0 }), BoardOpError);
  assert.throws(() => applyBoardOp(b, { op: "add", key: "x" }), BoardOpError);
  assert.throws(() => applyBoardOp(b, { op: "remove", key: "x" }), BoardOpError);
});

test("renameInBoard", () => {
  const b = sample();
  assert.deepEqual(renameInBoard(b, "A-1", "NEW-9").cards.Doing, ["NEW-9", "B-2"]);
  assert.deepEqual(renameInBoard(b, "A-1", "B-2").cards.Doing, ["B-2"]);
});

test("loadBoard / updateBoard", async () => {
  await ensureDataDir(dir, "PAY", examples);
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => updateBoard(dir, (b) => applyBoardOp(b, { op: "add", key: `K-${i + 1}` }))),
  );
  const b = await loadBoard(dir);
  assert.equal(boardKeys(b).length, 10);
  for (let i = 1; i <= 10; i++) assert.ok(boardKeys(b).includes(`K-${i}`));
});

test("updateBoard survives a hand edit and skips no-op writes", async () => {
  await ensureDataDir(dir, "PAY", examples);
  await updateBoard(dir, (b) => applyBoardOp(b, { op: "add", key: "A-1" }));
  const file = path.join(dir, "board.yaml");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("Doing: []", "Doing: [H-5]"));
  await updateBoard(dir, (b) => applyBoardOp(b, { op: "add", key: "B-2" }));
  const b = await loadBoard(dir);
  assert.deepEqual(b.cards.Doing, ["H-5"]);
  assert.deepEqual(b.cards.Backlog, ["A-1", "B-2"]);

  const hand = "columns: [Backlog, Doing, PEN, Done]\ncards: {Doing: [Z-1]}\n";
  await fs.writeFile(file, hand);
  await updateBoard(dir, (x) => x);
  assert.equal(await fs.readFile(file, "utf8"), hand, "an unchanged result is not rewritten");
});

test("broken board.yaml rejects and is left byte-identical; queue is not wedged", async () => {
  await ensureDataDir(dir, "PAY", examples);
  const file = path.join(dir, "board.yaml");
  await fs.writeFile(file, "columns: [a, b");
  await assert.rejects(
    updateBoard(dir, (b) => applyBoardOp(b, { op: "add", key: "A-1" })),
    (e: unknown) => e instanceof ConfigFileError && e.file.endsWith("board.yaml"),
  );
  assert.equal(await fs.readFile(file, "utf8"), "columns: [a, b");
  await assert.rejects(loadBoard(dir), ConfigFileError);

  await fs.writeFile(file, "columns: [Backlog, Done]\n");
  await assert.rejects(updateBoard(dir, () => { throw new BoardOpError("boom"); }), BoardOpError);
  const b = await updateBoard(dir, (x) => applyBoardOp(x, { op: "add", key: "A-1" }));
  assert.deepEqual(b.cards.Backlog, ["A-1"]);
});

test("eventForPath maps board.yaml", () => {
  assert.deepEqual(eventForPath("board.yaml"), { type: "board" });
  assert.deepEqual(eventForPath("links.yaml"), { type: "links" });
});

test("parseBoard upper-cases and trims hand-typed keys (deduping after normalising)", () => {
  const b = parseBoard("columns: [A, B]\ncards:\n  A: [pay-1, ' Pay-2 ']\n  B: [PAY-1]\n", "board.yaml");
  assert.deepEqual(b.cards, { A: ["PAY-1", "PAY-2"], B: [] });
});

test("ticket files are ignored by the watcher", () => {
  assert.equal(eventForPath("jira/tickets/AAA-1.md"), null);
});

test("eventForPath maps reading items, reading groom files and reading.yaml", () => {
  assert.deepEqual(eventForPath("reading/items/2026-10-25-a.md"), { type: "reading", id: "2026-10-25-a" });
  assert.deepEqual(eventForPath("reading/groom/2026-10-25-a.md"), { type: "readingGroom", id: "2026-10-25-a" });
  assert.deepEqual(eventForPath("reading.yaml"), { type: "readingConfig" });
  assert.equal(eventForPath("reading/items/Bad Id.md"), null);
  assert.equal(eventForPath(".cache/trash/reading/2026-10-25-a.1.md"), null);
});

test("parseBoard keeps reading:<id> entries as written and still upper-cases ticket keys", () => {
  const b = parseBoard("columns: [Backlog, Done]\ncards:\n  Backlog: [a-1, reading:2026-10-25-a]\n  Done: []\n", "board.yaml");
  assert.deepEqual(b.cards.Backlog, ["A-1", "reading:2026-10-25-a"]);
});

test("parseBoard drops reading:Bad Id with a warning", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const b = parseBoard("columns: [Backlog]\ncards:\n  Backlog: [\"reading:Bad Id\"]\n", "board.yaml");
  assert.deepEqual(b.cards.Backlog, []);
  assert.equal(warn.mock.callCount(), 1);
});

test("applyBoardOp add/move/remove work for reading:<id>", () => {
  const b = sample();
  const added = applyBoardOp(b, { op: "add", key: "reading:2026-10-25-a" });
  assert.deepEqual(added.cards.Backlog, ["reading:2026-10-25-a"]);
  const moved = applyBoardOp(added, { op: "move", key: "reading:2026-10-25-a", column: "Done", index: 0 });
  assert.deepEqual(moved.cards.Done, ["reading:2026-10-25-a", "C-3"]);
  assert.deepEqual(applyBoardOp(moved, { op: "remove", key: "reading:2026-10-25-a" }).cards.Done, ["C-3"]);
  assert.throws(() => applyBoardOp(b, { op: "add", key: "reading:Bad Id" }), BoardOpError);
});

test("eventForPath maps analysis.yaml", () => {
  assert.deepEqual(eventForPath("analysis.yaml"), { type: "analysis" });
});
