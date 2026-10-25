import fs from "node:fs/promises";
import path from "node:path";
import { guessFromUrl, isReadingId, makeReadingId, normaliseUrl } from "../shared/reading.ts";
import type { NoteFile, ReadingItem, ReadingSource, ReadingSummary } from "../shared/types.ts";
import { InvalidKeyError, isValidKey, parseFrontMatter, stringifyFrontMatter } from "./frontMatter.ts";
import { atomicWrite, type WriteResult } from "./notesStore.ts";

export class InvalidUrlError extends Error {
  constructor() {
    super("Enter a link starting with http:// or https://");
    this.name = "InvalidUrlError";
  }
}

export class InvalidReadingIdError extends Error {
  constructor(id: string) {
    super(`Invalid reading id: ${JSON.stringify(id)}`);
    this.name = "InvalidReadingIdError";
  }
}

export type ReadingPatch = Partial<{ title: string; url: string; status: string; category: string | null; tickets: string[] }>;

const SOURCES: readonly ReadingSource[] = ["confluence", "slack", "video", "web"];
/** Front-matter keys the app owns, in the order it writes them; anything else in the file is kept after them. */
const OWN_KEYS = ["id", "url", "title", "status", "category", "tickets", "links", "source", "created"];

interface RawFile {
  id: string;
  data: Record<string, unknown>;
  body: string;
  mtimeMs: number;
  birthtimeMs: number;
  parseError: string | null;
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const ticketLink = (key: string) => `[[jira/tickets/${key}|${key}]]`;

function toIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" && v.trim() !== "") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

function cleanTickets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const key = String(x).trim().toUpperCase();
    if (isValidKey(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Keys from a patch: upper-cased, validated (throws InvalidKeyError), de-duplicated. */
function patchTickets(keys: string[]): string[] {
  const out: string[] = [];
  for (const raw of keys) {
    const key = raw.trim().toUpperCase();
    if (!isValidKey(key)) throw new InvalidKeyError(raw);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function ordered(data: Record<string, unknown>): Record<string, unknown> {
  const tickets = cleanTickets(data.tickets);
  const own: Record<string, unknown> = {
    id: data.id,
    url: data.url,
    title: data.title,
    status: data.status,
    category: data.category,
    tickets,
    links: tickets.map(ticketLink),
    source: data.source,
    created: data.created,
  };
  const out: Record<string, unknown> = {};
  for (const k of OWN_KEYS) if (own[k] !== undefined && own[k] !== null) out[k] = own[k];
  for (const [k, v] of Object.entries(data)) if (!OWN_KEYS.includes(k)) out[k] = v;
  return out;
}

function groomSummary(data: Record<string, unknown>, body: string): string {
  if (typeof data.summary === "string" && data.summary.trim()) return data.summary.trim();
  const line = body.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.replace(/^\s*#+\s*/, "").trim();
}

/** Reading list items: NOTES_DIR/reading/items/<id>.md (front matter + the user's note) and Claude's reading/groom/<id>.md. */
export class ReadingStore {
  readonly notesDir: string;
  private queues = new Map<string, Promise<unknown>>();

  constructor(notesDir: string) {
    this.notesDir = path.resolve(notesDir);
  }

  itemPath(id: string): string {
    return path.join(this.notesDir, "reading", "items", `${this.assertId(id)}.md`);
  }

  groomPath(id: string): string {
    return path.join(this.notesDir, "reading", "groom", `${this.assertId(id)}.md`);
  }

  /** The note lives in the item file; named separately for the Claude prompt. */
  notePath(id: string): string {
    return this.itemPath(id);
  }

  async list(): Promise<ReadingItem[]> {
    const items: ReadingItem[] = [];
    for (const id of await this.ids()) {
      const item = await this.read(id);
      if (item) items.push(item);
    }
    return items;
  }

  async read(id: string): Promise<ReadingItem | null> {
    const raw = await this.readRaw(id);
    return raw ? this.toItem(raw) : null;
  }

  async add(
    url: string,
    opts: { jiraBaseUrl: string | null; defaultStatus: string; now: Date },
  ): Promise<{ item: ReadingItem; existed: boolean }> {
    const norm = normaliseUrl(url);
    if (norm === null) throw new InvalidUrlError();
    return this.serial("__add", async () => {
      const items = await this.list();
      const same = items.find((i) => normaliseUrl(i.url) === norm);
      if (same) return { item: same, existed: true };
      const { title, source } = guessFromUrl(norm, opts.jiraBaseUrl);
      const created = opts.now.toISOString();
      const id = makeReadingId(created, title, new Set(await this.ids()));
      const data = { id, url: norm, title, status: opts.defaultStatus, tickets: [], source, created };
      await atomicWrite(this.itemPath(id), stringifyFrontMatter(ordered(data), ""));
      return { item: (await this.read(id))!, existed: false };
    });
  }

  async setFields(id: string, patch: ReadingPatch): Promise<WriteResult> {
    const tickets = patch.tickets === undefined ? undefined : patchTickets(patch.tickets);
    return this.serial(id, async () => {
      const raw = await this.readRaw(id);
      if (!raw) return { ok: false, conflict: null, reason: "conflict" };
      if (raw.parseError) return { ok: false, conflict: this.noteFile(raw), reason: "parse-error" };
      const data = { ...raw.data };
      if (patch.title !== undefined) data.title = patch.title.trim() || raw.id;
      if (patch.url !== undefined) {
        const norm = normaliseUrl(patch.url);
        if (norm === null) throw new InvalidUrlError();
        data.url = norm;
      }
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.category !== undefined) data.category = patch.category;
      if (tickets !== undefined) data.tickets = tickets;
      return this.write(id, data, raw.body);
    });
  }

  writeNote(id: string, body: string, opts: { baseMtimeMs: number | null; force?: boolean }): Promise<WriteResult> {
    return this.serial(id, async () => {
      const raw = await this.readRaw(id);
      if (!raw) return { ok: false, conflict: null, reason: "conflict" };
      if (!opts.force && opts.baseMtimeMs !== raw.mtimeMs) return { ok: false, conflict: this.noteFile(raw), reason: "conflict" };
      if (raw.parseError) return { ok: false, conflict: this.noteFile(raw), reason: "parse-error" };
      return this.write(id, raw.data, body);
    });
  }

  /** Moves the item (and its groom file) to .cache/trash/reading; false when there is no such item. */
  remove(id: string): Promise<boolean> {
    return this.serial(id, async () => {
      const trash = path.join(this.notesDir, ".cache", "trash", "reading");
      const stamp = Date.now();
      await fs.mkdir(trash, { recursive: true });
      try {
        await fs.rename(this.itemPath(id), path.join(trash, `${id}.${stamp}.md`));
      } catch (e) {
        if (isMissing(e)) return false;
        throw e;
      }
      await fs.rename(this.groomPath(id), path.join(trash, `${id}-groom.${stamp}.md`)).catch((e) => {
        if (!isMissing(e)) throw e;
      });
      return true;
    });
  }

  /** A ticket moved to a new key: rewrite `tickets`/`links` (never the note) where the old key is linked. */
  async renameTicketKey(oldKey: string, newKey: string): Promise<string[]> {
    const changed: string[] = [];
    for (const id of await this.ids()) {
      const done = await this.serial(id, async () => {
        const raw = await this.readRaw(id);
        if (!raw || raw.parseError) return false;
        const tickets = cleanTickets(raw.data.tickets);
        if (!tickets.includes(oldKey)) return false;
        const next = tickets.includes(newKey) ? tickets.filter((k) => k !== oldKey) : tickets.map((k) => (k === oldKey ? newKey : k));
        const r = await this.write(id, { ...raw.data, tickets: next }, raw.body);
        return r.ok;
      });
      if (done) changed.push(id);
    }
    return changed;
  }

  /** Ticket key → the items that link it, by title. */
  async ticketIndex(): Promise<Map<string, ReadingSummary[]>> {
    const index = new Map<string, ReadingSummary[]>();
    for (const item of await this.list()) {
      for (const key of item.tickets) {
        const list = index.get(key) ?? [];
        list.push({ id: item.id, title: item.title, status: item.status, url: item.url, source: item.source });
        index.set(key, list);
      }
    }
    for (const list of index.values()) list.sort((a, b) => a.title.localeCompare(b.title));
    return index;
  }

  private assertId(id: string): string {
    if (!isReadingId(id)) throw new InvalidReadingIdError(id);
    return id;
  }

  private async ids(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.notesDir, "reading", "items"));
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
    return names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).filter(isReadingId).sort();
  }

  /** One promise chain per id, so read-modify-write cycles on one file never interleave. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = result.catch(() => {});
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }

  private async readText(file: string): Promise<{ text: string; mtimeMs: number; birthtimeMs: number } | null> {
    try {
      // Read and stat through one handle, retrying once if the file changed mid-read (as NotesStore does).
      let out = { text: "", mtimeMs: 0, birthtimeMs: 0 };
      for (let attempt = 0; attempt < 2; attempt++) {
        const fh = await fs.open(file, "r");
        try {
          const before = await fh.stat();
          const text = await fh.readFile("utf8");
          const after = await fh.stat();
          out = { text, mtimeMs: after.mtimeMs, birthtimeMs: after.birthtimeMs };
          if (before.mtimeMs === after.mtimeMs) break;
        } finally {
          await fh.close();
        }
      }
      return out;
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  private async readRaw(id: string): Promise<RawFile | null> {
    const f = await this.readText(this.itemPath(id));
    if (!f) return null;
    const doc = parseFrontMatter(f.text);
    return { id, data: doc.data, body: doc.body, mtimeMs: f.mtimeMs, birthtimeMs: f.birthtimeMs, parseError: doc.error };
  }

  private async toItem(raw: RawFile): Promise<ReadingItem> {
    const d = raw.data;
    const url = typeof d.url === "string" ? d.url : "";
    const source = SOURCES.includes(d.source as ReadingSource) ? (d.source as ReadingSource) : guessFromUrl(url, null).source;
    const birth = raw.birthtimeMs > 0 ? raw.birthtimeMs : raw.mtimeMs;
    const g = await this.readText(this.groomPath(raw.id));
    let groom: ReadingItem["groom"] = null;
    if (g) {
      const doc = parseFrontMatter(g.text);
      groom = {
        summary: groomSummary(doc.data, doc.body),
        groomedAt: toIso(doc.data.groomed_at) ?? new Date(g.mtimeMs).toISOString(),
      };
    }
    return {
      id: raw.id,
      url,
      title: raw.parseError ? raw.id : typeof d.title === "string" && d.title.trim() ? d.title : raw.id,
      status: raw.parseError ? "" : typeof d.status === "string" ? d.status : "",
      source,
      category: typeof d.category === "string" && d.category !== "" ? d.category : null,
      tickets: cleanTickets(d.tickets),
      created: toIso(d.created) ?? new Date(birth).toISOString(),
      updated: new Date(raw.mtimeMs).toISOString(),
      mtimeMs: raw.mtimeMs,
      note: raw.parseError ? "" : raw.body,
      groom,
      parseError: raw.parseError,
    };
  }

  private noteFile(raw: RawFile): NoteFile {
    return { key: raw.id, data: raw.data, body: raw.body, mtimeMs: raw.mtimeMs, parseError: raw.parseError };
  }

  private async write(id: string, data: Record<string, unknown>, body: string): Promise<WriteResult> {
    const file = this.itemPath(id);
    await atomicWrite(file, stringifyFrontMatter(ordered({ ...data, id }), body));
    return { ok: true, mtimeMs: (await fs.stat(file)).mtimeMs };
  }
}
