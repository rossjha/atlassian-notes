import fs from "node:fs/promises";
import path from "node:path";
import type { BoardCard, BoardOp, BoardResponse, LiveEvent, ReadingSummary, Ticket } from "../shared/types.ts";
import { readingIdFromCard } from "../shared/reading.ts";
import { applyBoardOp, boardKeys, loadBoard, renameInBoard, updateBoard } from "./board.ts";
import type { ViewCache } from "./cache.ts";
import { ConfigFileError } from "./configFiles.ts";
import { JiraError, type JiraClient } from "./jira.ts";
import { atomicWrite, type NotesStore } from "./notesStore.ts";
import { buildRow } from "./rows.ts";

export const BOARD_CACHE_ID = "_board";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 50;

export interface BoardServiceDeps {
  jira: JiraClient;
  cache: ViewCache;
  notes: NotesStore;
  notesDir: string;
  statePath: string;
  onChange: (e: LiveEvent) => void;
  now?: () => Date;
  /** Reading list cards (reading:<id>): their summary for the board, and marking archived ones done. */
  reading?: { summary(id: string): Promise<ReadingSummary | null>; markDone(ids: string[]): Promise<void> };
  /** A board ticket turned out to have a new key: lets the reading list follow. */
  onTicketRenamed?: (oldKey: string, newKey: string) => Promise<void>;
}

const isTicketCard = (key: string): boolean => readingIdFromCard(key) === null;

interface State {
  notFound: Record<string, string>;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class BoardService {
  private deps: BoardServiceDeps;
  private running: Promise<void> | null = null;
  private pending: Promise<void> | null = null;

  constructor(deps: BoardServiceDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private async loadState(): Promise<State> {
    try {
      const s = JSON.parse(await fs.readFile(this.deps.statePath, "utf8"));
      if (s && typeof s.notFound === "object" && s.notFound !== null && !Array.isArray(s.notFound)) {
        return { notFound: s.notFound };
      }
    } catch {
      // missing or corrupt
    }
    return { notFound: {} };
  }

  private recentlyNotFound(state: State, key: string): boolean {
    const at = state.notFound[key];
    if (typeof at !== "string") return false;
    const age = this.now().getTime() - Date.parse(at);
    return Number.isFinite(age) && age >= 0 && age < DAY_MS;
  }

  async tickets(): Promise<Map<string, Ticket>> {
    return new Map((await this.deps.cache.read(BOARD_CACHE_ID)).tickets.map((t) => [t.key, t]));
  }

  refresh(): Promise<void> {
    if (!this.running) {
      const p = this.doRefresh().finally(() => {
        if (this.running === p) this.running = null;
      });
      this.running = p;
      return p;
    }
    if (!this.pending) {
      const follow = this.running
        .catch(() => {})
        .then(() => {
          this.pending = null;
          return this.refresh();
        });
      this.pending = follow;
    }
    return this.pending;
  }

  private async doRefresh(): Promise<void> {
    const { jira, cache, notes, notesDir, onChange } = this.deps;
    let keys: string[];
    try {
      keys = boardKeys(await loadBoard(notesDir)).filter(isTicketCard);
    } catch (e) {
      if (!(e instanceof ConfigFileError)) console.error("board refresh: cannot read board.yaml:", errMessage(e));
      return;
    }
    const prev = await cache.read(BOARD_CACHE_ID);
    const prevByKey = new Map(prev.tickets.map((t) => [t.key, t]));
    const state = await this.loadState();
    const result = new Map<string, Ticket>();
    const errors: string[] = [];
    const nowIso = this.now().toISOString();

    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const searchKeys = chunk.filter((k) => !this.recentlyNotFound(state, k));
      if (searchKeys.length === 0) continue;
      let returned: Ticket[] = [];
      try {
        returned = await jira.search(`key in (${searchKeys.join(",")})`, searchKeys.length);
      } catch (e) {
        if (!(e instanceof JiraError && e.status === 400)) {
          errors.push(e instanceof JiraError ? e.messages.join("; ") || e.message : errMessage(e));
          for (const k of chunk) {
            const old = prevByKey.get(k);
            if (old) result.set(k, old);
          }
          continue;
        }
      }
      for (const tk of returned) result.set(tk.key, tk);
      for (const key of searchKeys) {
        if (result.has(key)) {
          delete state.notFound[key];
          continue;
        }
        let found: Ticket;
        try {
          found = (await jira.getIssueDetail(key)).ticket;
        } catch (e) {
          if (e instanceof JiraError && e.status === 404) state.notFound[key] = nowIso;
          else console.error(`board lookup of ${key} failed:`, errMessage(e));
          continue;
        }
        delete state.notFound[key];
        if (found.key !== key) {
          try {
            await updateBoard(notesDir, (b) => renameInBoard(b, key, found.key));
            if ((await notes.readNote(key)) || (await notes.readGroom(key))) {
              const res = await notes.renameKey(key, found.key);
              if (res === "renamed") {
                onChange({ type: "note", key: found.key });
                onChange({ type: "groom", key: found.key });
              } else {
                console.error(`board rename ${key} -> ${found.key}: ${res}; note stays under ${key}`);
              }
            }
            await this.deps.onTicketRenamed?.(key, found.key);
            onChange({ type: "board" });
          } catch (e) {
            console.error(`board rename ${key} -> ${found.key} failed:`, errMessage(e));
          }
        }
        result.set(found.key, found);
      }
    }

    // prune not-found entries for keys no longer on the board
    let current: string[] = keys;
    try {
      current = boardKeys(await loadBoard(notesDir));
    } catch {
      // keep what we have
    }
    for (const k of Object.keys(state.notFound)) if (!current.includes(k)) delete state.notFound[k];
    try {
      await fs.mkdir(path.dirname(this.deps.statePath), { recursive: true });
      await atomicWrite(this.deps.statePath, JSON.stringify(state));
    } catch (e) {
      console.error("board state write failed:", errMessage(e));
    }

    const tickets = [...result.values()];
    await cache.write(BOARD_CACHE_ID, {
      fetchedAt: nowIso,
      tickets,
      error: errors.length ? errors.join("; ") : null,
    });
    for (const tk of tickets) {
      try {
        await notes.ensureIdentity(tk.key, tk.id);
      } catch {
        // invalid key or unreadable file: leave it alone
      }
    }
    onChange({ type: "board" });
  }

  async rename(oldKey: string, newKey: string): Promise<void> {
    const before = await loadBoard(this.deps.notesDir);
    const after = await updateBoard(this.deps.notesDir, (b) => renameInBoard(b, oldKey, newKey));
    if (boardKeys(before).join("\n") !== boardKeys(after).join("\n")) this.deps.onChange({ type: "board" });
  }

  private async knownKeys(): Promise<Set<string>> {
    const { cache, notesDir } = this.deps;
    const ids: string[] = [];
    try {
      for (const f of await fs.readdir(path.join(path.resolve(notesDir), ".cache", "views"))) {
        if (f.endsWith(".json")) ids.push(f.slice(0, -5));
      }
    } catch {
      // no cache yet
    }
    const known = new Set<string>();
    for (const id of ids) for (const tk of (await cache.read(id)).tickets) known.add(tk.key);
    return known;
  }

  async apply(op: BoardOp): Promise<void> {
    const { notesDir, onChange, reading } = this.deps;
    let archived: string[] = [];
    await updateBoard(notesDir, (b) => {
      if (op.op === "archive") {
        archived = (b.cards[b.archiveColumn] ?? []).map(readingIdFromCard).filter((id): id is string => id !== null);
      }
      return applyBoardOp(b, op);
    });
    onChange({ type: "board" });
    if (archived.length && reading) {
      try {
        await reading.markDone(archived);
      } catch (e) {
        console.error("archive: marking reading items done failed:", errMessage(e));
      }
    }
    if ((op.op === "add" || op.op === "move") && isTicketCard(op.key) && !(await this.knownKeys()).has(op.key)) {
      this.refresh().catch((e) => console.error("board refresh failed:", errMessage(e)));
    }
  }

  async view(customIds: string[], viewIds: string[]): Promise<BoardResponse> {
    const { cache, notes, notesDir } = this.deps;
    let board;
    try {
      board = await loadBoard(notesDir);
    } catch (e) {
      let msg: string;
      if (e instanceof ConfigFileError) msg = e.message;
      else {
        console.error("board.yaml read failed:", e); // raw errno messages carry absolute paths
        msg = "board.yaml could not be read";
      }
      return { columns: [], archiveColumn: "", noteColumn: "", cards: {}, fetchedAt: null, error: msg, locked: true };
    }
    const cached = await cache.read(BOARD_CACHE_ID);
    const own = new Map(cached.tickets.map((t) => [t.key, t]));
    const fromViews = await cache.allTickets(viewIds);
    const state = await this.loadState();
    const cards: Record<string, BoardCard[]> = {};
    for (const col of board.columns) {
      cards[col] = [];
      for (const key of board.cards[col] ?? []) {
        const readingId = readingIdFromCard(key);
        if (readingId !== null) {
          const summary = this.deps.reading ? await this.deps.reading.summary(readingId) : null;
          cards[col].push({ key, row: null, missing: summary === null, reading: summary });
          continue;
        }
        const ticket = own.get(key) ?? fromViews.get(key);
        let row = null;
        if (ticket) {
          const [note, groom] = await Promise.all([notes.readNote(key), notes.readGroom(key)]);
          row = buildRow(ticket, note, groom, customIds);
        }
        cards[col].push({ key, row, missing: this.recentlyNotFound(state, key) });
      }
    }
    return {
      columns: board.columns,
      archiveColumn: board.archiveColumn,
      noteColumn: board.noteColumn,
      cards,
      fetchedAt: cached.fetchedAt,
      error: cached.error,
      locked: false,
    };
  }
}
