import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { BoardFile, BoardOp } from "../shared/types.ts";
import { ConfigFileError } from "./configFiles.ts";
import { isValidKey } from "./frontMatter.ts";
import { atomicWrite } from "./notesStore.ts";

export class BoardOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardOpError";
  }
}

const DEFAULT_BOARD: BoardFile = {
  columns: ["Backlog", "Doing", "PEN", "Done"],
  archiveColumn: "Done",
  noteColumn: "Doing",
  cards: { Backlog: [], Doing: [], PEN: [], Done: [] },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseBoard(text: string, file: string): BoardFile {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new ConfigFileError(file, `invalid YAML (${(e as Error).message.split("\n")[0]})`);
  }
  if (!isObj(raw)) throw new ConfigFileError(file, "top level must be a mapping");
  const cols = raw.columns;
  if (!Array.isArray(cols) || cols.length === 0 || !cols.every((c) => typeof c === "string" && c !== "")) {
    throw new ConfigFileError(file, "columns must be a non-empty list of names");
  }
  const columns = cols as string[];
  if (new Set(columns).size !== columns.length) throw new ConfigFileError(file, "columns has duplicate names");
  const archiveColumn = raw.archiveColumn ?? columns[columns.length - 1];
  if (typeof archiveColumn !== "string" || !columns.includes(archiveColumn)) {
    throw new ConfigFileError(file, `archiveColumn "${String(archiveColumn)}" is not one of the columns`);
  }
  const noteColumn = raw.noteColumn ?? (columns.includes("Doing") ? "Doing" : columns[0]);
  if (typeof noteColumn !== "string" || !columns.includes(noteColumn)) {
    throw new ConfigFileError(file, `noteColumn "${String(noteColumn)}" is not one of the columns`);
  }
  const rawCards = raw.cards ?? {};
  if (!isObj(rawCards)) throw new ConfigFileError(file, "cards must be a mapping");

  const cards: Record<string, string[]> = Object.fromEntries(columns.map((c) => [c, [] as string[]]));
  const seen = new Set<string>();
  const place = (col: string, list: unknown) => {
    if (list === null || list === undefined) return;
    if (!Array.isArray(list)) throw new ConfigFileError(file, `cards for "${col}" must be a list`);
    for (const item of list) {
      const key = String(item);
      if (!isValidKey(key)) {
        console.warn(`${file}: ignoring invalid ticket key "${key}"`);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      cards[col].push(key);
    }
  };
  for (const c of columns) if (Object.hasOwn(rawCards, c)) place(c, rawCards[c]);
  for (const [c, list] of Object.entries(rawCards)) if (!columns.includes(c)) place(columns[0], list);
  return { columns, archiveColumn, noteColumn, cards };
}

export function serialiseBoard(b: BoardFile): string {
  const columns = new YAML.YAMLSeq();
  columns.flow = true;
  for (const c of b.columns) columns.items.push(c);
  const doc = new YAML.Document({
    columns,
    archiveColumn: b.archiveColumn,
    noteColumn: b.noteColumn,
    cards: Object.fromEntries(b.columns.map((c) => [c, b.cards[c] ?? []])),
  });
  return doc.toString({ flowCollectionPadding: false });
}

export function boardKeys(b: BoardFile): string[] {
  return b.columns.flatMap((c) => b.cards[c] ?? []);
}

function clone(b: BoardFile): BoardFile {
  return {
    columns: [...b.columns],
    archiveColumn: b.archiveColumn,
    noteColumn: b.noteColumn,
    cards: Object.fromEntries(b.columns.map((c) => [c, [...(b.cards[c] ?? [])]])),
  };
}

function withoutKey(b: BoardFile, key: string): BoardFile {
  const out = clone(b);
  for (const c of out.columns) out.cards[c] = out.cards[c].filter((k) => k !== key);
  return out;
}

export function applyBoardOp(b: BoardFile, op: BoardOp): BoardFile {
  if (op.op === "archive") {
    const out = clone(b);
    out.cards[out.archiveColumn] = [];
    return out;
  }
  if (!isValidKey(op.key)) throw new BoardOpError(`invalid ticket key "${op.key}"`);
  switch (op.op) {
    case "add":
    {
      const out = clone(b);
      if (!boardKeys(b).includes(op.key)) out.cards[out.columns[0]].push(op.key);
      return out;
    }
    case "remove":
      return withoutKey(b, op.key);
    case "move": {
      if (!b.columns.includes(op.column)) throw new BoardOpError(`unknown column "${op.column}"`);
      const out = withoutKey(b, op.key);
      const list = out.cards[op.column];
      const index = Math.max(0, Math.min(Number.isFinite(op.index) ? Math.trunc(op.index) : list.length, list.length));
      list.splice(index, 0, op.key);
      return out;
    }
  }
}

export function renameInBoard(b: BoardFile, oldKey: string, newKey: string): BoardFile {
  const out = clone(b);
  const hasNew = boardKeys(b).includes(newKey);
  for (const c of out.columns) {
    out.cards[c] = hasNew
      ? out.cards[c].filter((k) => k !== oldKey)
      : out.cards[c].map((k) => (k === oldKey ? newKey : k));
  }
  return out;
}

async function readBoard(notesDir: string): Promise<BoardFile> {
  const file = path.join(notesDir, "board.yaml");
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return clone(DEFAULT_BOARD);
    throw e;
  }
  return parseBoard(text, file);
}

export function loadBoard(notesDir: string): Promise<BoardFile> {
  return readBoard(notesDir);
}

const queues = new Map<string, Promise<unknown>>();

export function updateBoard(notesDir: string, fn: (b: BoardFile) => BoardFile): Promise<BoardFile> {
  const id = path.resolve(notesDir);
  const run = async (): Promise<BoardFile> => {
    const current = await readBoard(notesDir);
    const next = fn(current);
    if (serialiseBoard(next) !== serialiseBoard(current)) {
      await atomicWrite(path.join(notesDir, "board.yaml"), serialiseBoard(next));
    }
    return next;
  };
  const result = (queues.get(id) ?? Promise.resolve()).then(run, run);
  const tail = result.catch(() => {});
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return result;
}
