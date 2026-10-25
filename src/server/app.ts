import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { BoardOp, ColumnsConfig, IssueDetail, LiveEvent, Row, View } from "../shared/types.ts";
import type { ViewCache } from "./cache.ts";
import type { Config } from "./config.ts";
import { BoardOpError } from "./board.ts";
import { BOARD_CACHE_ID, type BoardService } from "./boardService.ts";
import { ConfigFileError, DEFAULT_READING_CONFIG, loadColumns, loadLinks, loadReadingConfig, loadViews, saveViews, validateViews } from "./configFiles.ts";
import { bothMarkdown, groomPrompt, readingBothMarkdown, readingLinkMarkdown, readingPrompt, ticketMarkdown } from "./copyText.ts";
import { InvalidKeyError, isValidKey } from "./frontMatter.ts";
import { JiraError, type JiraClient } from "./jira.ts";
import { renderMarkdownSafe } from "./markdown.ts";
import { atomicWrite, type NotesStore, type WriteResult } from "./notesStore.ts";
import { buildRow } from "./rows.ts";
import type { Refresher } from "./refresher.ts";
import { InvalidReadingIdError, InvalidUrlError, type ReadingPatch, type ReadingStore } from "./readingStore.ts";
import { isReadingId } from "../shared/reading.ts";
import type { ReadingConfig } from "../shared/types.ts";

export interface AppDeps {
  config: Config;
  jira: JiraClient;
  notes: NotesStore;
  cache: ViewCache;
  refresher: Refresher;
  board: BoardService;
  reading: ReadingStore;
  publicDir: string;
}

// img-src adds data: and blob: for images pasted or dropped into the Scratchpad (Excalidraw decodes them from
// in-memory URLs). Neither reaches the network; fetches, scripts and fonts stay 'self'.
const CSP = "default-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 1024 * 1024;
/** Scratchpad scenes embed pasted images as data URLs, so they get a larger limit. */
const MAX_SCRATCHPAD_BODY = 50 * 1024 * 1024;
const SCRATCHPAD_FILE = "scratchpad.excalidraw";
const PING_MS = 25_000;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};
const FALLBACK_COLUMNS: ColumnsConfig = {
  jiraFields: { storyPoints: null, sprint: "customfield_10020", acceptanceCriteria: null },
  custom: {},
  groomPrompt: "",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(deps: AppDeps): { server: http.Server; broadcast: (e: LiveEvent) => void } {
  const { config, jira, notes, cache, refresher, board, reading } = deps;
  const publicDir = path.resolve(deps.publicDir);
  const clients = new Set<http.ServerResponse>();

  function broadcast(e: LiveEvent): void {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(line);
  }

  function send(res: http.ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(text);
  }

  function sendText(res: http.ServerResponse, status: number, text: string): void {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(text);
  }

  async function readJson(req: http.IncomingMessage, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, "Request body too large");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "Body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  async function currentViews(): Promise<{ columns: ColumnsConfig; views: View[] }> {
    const columns = await loadColumns(config.notesDir);
    return { columns, views: await loadViews(config.notesDir, columns) };
  }

  async function findView(id: string): Promise<View> {
    const { views } = await currentViews();
    const view = views.find((v) => v.id === id);
    if (!view) throw new HttpError(404, "Unknown view");
    return view;
  }

  async function rowsFor(view: View, columns: ColumnsConfig) {
    const cached = await cache.read(view.id);
    const { notes: noteFiles, grooms } = await notes.listAll();
    const noteBy = new Map(noteFiles.map((n) => [n.key, n]));
    const groomBy = new Map(grooms.map((g) => [g.key, g]));
    const customIds = Object.keys(columns.custom);
    const rows: Row[] = cached.tickets.map((t) =>
      buildRow(t, noteBy.get(t.key) ?? null, groomBy.get(t.key) ?? null, customIds),
    );
    return { rows, fetchedAt: cached.fetchedAt, error: cached.error };
  }

  async function jiraIdFor(key: string): Promise<string | undefined> {
    try {
      const { views } = await currentViews();
      return (await cache.allTickets([BOARD_CACHE_ID, ...views.map((v) => v.id)])).get(key)?.id;
    } catch {
      return undefined;
    }
  }

  async function readScratchpad(): Promise<{ scene: Record<string, unknown> | null; error: string | null }> {
    let text: string;
    try {
      text = await fs.readFile(path.join(config.notesDir, SCRATCHPAD_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { scene: null, error: null };
      throw e;
    }
    try {
      const scene: unknown = JSON.parse(text);
      if (typeof scene === "object" && scene !== null && !Array.isArray(scene)) return { scene: scene as Record<string, unknown>, error: null };
    } catch {
      // reported below
    }
    return { scene: null, error: `${SCRATCHPAD_FILE} is not valid Excalidraw JSON; fix or remove it` };
  }

  function sendWrite(res: http.ServerResponse, r: WriteResult): void {
    if (r.ok) return send(res, 200, { mtimeMs: r.mtimeMs });
    if (r.reason === "conflict") {
      if (r.conflict === null) return send(res, 409, { current: null, error: "This note was deleted on disk since you opened it" });
      return send(res, 409, { current: r.conflict });
    }
    send(res, 422, { error: `${r.conflict?.key ?? "Note"}: front matter could not be parsed; fix the file by hand` });
  }

  function requireKey(key: string): void {
    if (!isValidKey(key)) throw new HttpError(400, "Invalid ticket key");
  }

  async function boardView() {
    let customIds: string[] = [];
    let viewIds: string[] = [];
    try {
      const columns = await loadColumns(config.notesDir);
      customIds = Object.keys(columns.custom);
      viewIds = (await loadViews(config.notesDir, columns)).map((v) => v.id);
    } catch (err) {
      console.warn("board: columns/views unavailable, serving board without them:", err instanceof Error ? err.message : err);
    }
    return board.view(customIds, viewIds);
  }

  function parseBoardOp(body: Record<string, unknown>): BoardOp {
    const bad = (m: string) => new HttpError(400, m);
    const str = (k: string): string => {
      const v = body[k];
      if (typeof v !== "string") throw bad(`${k} must be a string`);
      return v;
    };
    switch (body.op) {
      case "archive":
        return { op: "archive" };
      case "add":
      case "remove":
        return { op: body.op, key: str("key") };
      case "move": {
        const key = str("key");
        const column = str("column");
        const index = body.index;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw bad("index must be a non-negative integer");
        return { op: "move", key, column, index };
      }
      default:
        throw bad("Unknown board op");
    }
  }

  function requireReadingId(id: string): void {
    if (!isReadingId(id)) throw new HttpError(400, "Invalid reading id");
  }

  /** reading.yaml, or the defaults plus the error while the file is broken. */
  async function readingConfig(): Promise<{ config: ReadingConfig; error: string | null }> {
    try {
      return { config: await loadReadingConfig(config.notesDir), error: null };
    } catch (err) {
      if (!(err instanceof ConfigFileError)) throw err;
      return { config: DEFAULT_READING_CONFIG, error: err.message };
    }
  }

  function parseReadingPatch(body: Record<string, unknown>): ReadingPatch {
    const bad = (m: string) => new HttpError(400, m);
    const patch: ReadingPatch = {};
    for (const k of ["title", "url", "status"] as const) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== "string") throw bad(`${k} must be a string`);
      patch[k] = body[k] as string;
    }
    if (body.category !== undefined) {
      if (body.category !== null && typeof body.category !== "string") throw bad("category must be a string or null");
      patch.category = body.category as string | null;
    }
    if (body.tickets !== undefined) {
      if (!Array.isArray(body.tickets) || !body.tickets.every((t) => typeof t === "string")) throw bad("tickets must be a list of keys");
      patch.tickets = body.tickets as string[];
    }
    return patch;
  }

  async function readingRoute(req: http.IncomingMessage, res: http.ServerResponse, method: string, segs: string[]): Promise<boolean> {
    const [, id, c, d] = segs;
    if (segs.length === 1 && method === "GET") {
      const { config: cfg, error } = await readingConfig();
      send(res, 200, { items: await reading.list(), config: cfg, error });
      return true;
    }
    if (segs.length === 1 && method === "POST") {
      const body = await readJson(req);
      if (typeof body.url !== "string") throw new HttpError(400, "url must be a string");
      const { config: cfg } = await readingConfig();
      try {
        const r = await reading.add(body.url, { jiraBaseUrl: config.jiraBaseUrl, defaultStatus: cfg.statuses[0], now: new Date() });
        send(res, r.existed ? 200 : 201, r);
      } catch (err) {
        if (err instanceof InvalidUrlError) throw new HttpError(400, err.message);
        throw err;
      }
      return true;
    }
    if (!id) return false;
    requireReadingId(id);
    if (segs.length === 2 && method === "PUT") {
      const patch = parseReadingPatch(await readJson(req));
      let cfg: ReadingConfig;
      try {
        cfg = await loadReadingConfig(config.notesDir);
      } catch (err) {
        if (err instanceof ConfigFileError) throw new HttpError(409, `${err.message} — fix the file before changing items`);
        throw err;
      }
      if (patch.status !== undefined && !cfg.statuses.includes(patch.status)) throw new HttpError(400, `Unknown status "${patch.status}"`);
      if (patch.category !== undefined && patch.category !== null && !cfg.categories.includes(patch.category)) {
        throw new HttpError(400, `Unknown category "${patch.category}"`);
      }
      if (!(await reading.read(id))) throw new HttpError(404, "No such reading item");
      try {
        sendWrite(res, await reading.setFields(id, patch));
      } catch (err) {
        if (err instanceof InvalidUrlError) throw new HttpError(400, err.message);
        throw err;
      }
      return true;
    }
    if (segs.length === 2 && method === "DELETE") {
      if (!(await reading.remove(id))) throw new HttpError(404, "No such reading item");
      send(res, 204);
      return true;
    }
    if (segs.length === 3 && c === "note" && method === "PUT") {
      const body = await readJson(req);
      if (typeof body.body !== "string") throw new HttpError(400, "body must be a string");
      const base = body.baseMtimeMs ?? null;
      if (base !== null && typeof base !== "number") throw new HttpError(400, "baseMtimeMs must be a number or null");
      if (!(await reading.read(id))) throw new HttpError(404, "No such reading item");
      sendWrite(res, await reading.writeNote(id, body.body, { baseMtimeMs: base, force: body.force === true }));
      return true;
    }
    if (segs.length === 4 && c === "copy" && d && method === "GET") {
      if (!["link", "note", "both", "prompt"].includes(d)) throw new HttpError(400, "Unknown copy kind");
      const item = await reading.read(id);
      if (!item) throw new HttpError(404, "No such reading item");
      if (d === "link") sendText(res, 200, readingLinkMarkdown(item));
      else if (d === "note") sendText(res, 200, item.note);
      else if (d === "both") {
        const groom = await fs.readFile(reading.groomPath(id), "utf8").catch(() => null);
        sendText(res, 200, readingBothMarkdown(item, groom));
      } else {
        const { config: cfg } = await readingConfig();
        sendText(res, 200, readingPrompt(cfg.groomPrompt, {
          url: item.url,
          title: item.title,
          tickets: item.tickets.length ? item.tickets.join(", ") : "none",
          groomPath: reading.groomPath(id),
          notePath: reading.notePath(id),
        }));
      }
      return true;
    }
    return false;
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, method: string, segs: string[]): Promise<void> {
    // segs excludes the leading "api"
    const [a, b, c, d, e] = segs;
    if (method === "GET" && a === "config" && segs.length === 1) {
      let columns = FALLBACK_COLUMNS;
      let views: View[] = [];
      let error: string | null = null;
      try {
        columns = await loadColumns(config.notesDir);
        views = await loadViews(config.notesDir, columns);
      } catch (err) {
        if (!(err instanceof ConfigFileError)) throw err;
        error = err.message;
      }
      const { links, error: linksError } = await loadLinks(config.notesDir);
      return send(res, 200, { views, columns, jiraBaseUrl: config.jiraBaseUrl, error, links, linksError });
    }
    if (method === "PUT" && a === "views" && segs.length === 1) {
      const body = await readJson(req);
      let columns: ColumnsConfig;
      try {
        // Never overwrite a config file the user broke by hand: refuse until it parses again.
        columns = await loadColumns(config.notesDir);
        await loadViews(config.notesDir, columns);
      } catch (err) {
        if (err instanceof ConfigFileError) return send(res, 409, { error: `${err.message} — fix the file before saving views` });
        throw err;
      }
      let views: View[];
      try {
        views = validateViews(body, columns);
      } catch (err) {
        if (err instanceof ConfigFileError) return send(res, 400, { error: err.message });
        throw err;
      }
      await saveViews(config.notesDir, views);
      return send(res, 204);
    }
    if (a === "views" && b && c === "rows" && segs.length === 3 && method === "GET") {
      const view = await findView(b);
      return send(res, 200, await rowsFor(view, await loadColumns(config.notesDir)));
    }
    if (a === "views" && b && c === "refresh" && segs.length === 3 && method === "POST") {
      const view = await findView(b);
      await refresher.refreshView(view);
      refresher.scheduleTicketFiles();
      return send(res, 200, await rowsFor(view, await loadColumns(config.notesDir)));
    }
    if (a === "orphans" && segs.length === 1 && method === "GET") {
      return send(res, 200, {
        orphans: refresher.orphans().map((key) => ({ key, notePath: notes.notePath(key), groomPath: notes.groomPath(key) })),
      });
    }
    if (a === "tickets" && b && segs.length === 2 && method === "GET") {
      requireKey(b);
      let detail: IssueDetail;
      try {
        detail = await jira.getIssueDetail(b);
      } catch (err) {
        if (err instanceof JiraError) {
          if (err.status === 404) return send(res, 404, { error: `${b} not found in Jira (deleted, or no permission)` });
          return send(res, 502, { error: err.message });
        }
        throw err;
      }
      // A moved ticket fetched by its old key: notes live under the canonical key.
      const key = isValidKey(detail.ticket.key) ? detail.ticket.key : b;
      const note = await notes.readNote(key);
      const groom = await notes.readGroom(key);
      return send(res, 200, {
        detail,
        html: {
          description: renderMarkdownSafe(detail.descriptionMd),
          acceptanceCriteria: detail.acceptanceCriteriaMd === null ? "" : renderMarkdownSafe(detail.acceptanceCriteriaMd),
          comments: detail.comments.map((cm) => renderMarkdownSafe(cm.bodyMd)),
        },
        note,
        noteHtml: note ? renderMarkdownSafe(note.body) : "",
        groom,
        groomHtml: groom ? renderMarkdownSafe(groom.body) : "",
        groomPath: notes.groomPath(key),
        reading: (await reading.ticketIndex()).get(key) ?? [],
      });
    }
    if (a === "tickets" && b && c === "copy" && d && segs.length === 4 && method === "GET") {
      requireKey(b);
      if (!["ticket", "notes", "both", "prompt"].includes(d)) throw new HttpError(400, "Unknown copy kind");
      if (d === "notes") return sendText(res, 200, (await notes.readNote(b))?.body ?? "");
      if (d === "prompt") {
        const columns = await loadColumns(config.notesDir);
        return sendText(res, 200, groomPrompt(columns.groomPrompt, {
          key: b,
          url: `${config.jiraBaseUrl}/browse/${b}`,
          groomPath: notes.groomPath(b),
        }));
      }
      let detail: IssueDetail;
      try {
        detail = await jira.getIssueDetail(b);
      } catch (err) {
        if (err instanceof JiraError) return send(res, 502, { error: err.message });
        throw err;
      }
      if (d === "ticket") return sendText(res, 200, ticketMarkdown(detail));
      return sendText(res, 200, bothMarkdown(detail, await notes.readNote(b), await notes.readGroom(b)));
    }
    if (a === "notes" && b && segs.length === 1 + 1 && method === "PUT") {
      requireKey(b);
      const body = await readJson(req);
      if (typeof body.body !== "string") throw new HttpError(400, "body must be a string");
      const base = body.baseMtimeMs ?? null;
      if (base !== null && typeof base !== "number") throw new HttpError(400, "baseMtimeMs must be a number or null");
      const r = await notes.writeNoteBody(b, body.body, {
        baseMtimeMs: base,
        jiraId: await jiraIdFor(b),
        force: body.force === true,
      });
      return sendWrite(res, r);
    }
    if (a === "notes" && b && c === "fields" && d && e === undefined && segs.length === 4 && method === "PUT") {
      requireKey(b);
      const columns = await loadColumns(config.notesDir);
      if (!Object.hasOwn(columns.custom, d)) throw new HttpError(400, "Not a custom column");
      const body = await readJson(req);
      if (body.value !== null && typeof body.value !== "string") throw new HttpError(400, "value must be a string or null");
      return sendWrite(res, await notes.setNoteField(b, d, body.value, await jiraIdFor(b)));
    }
    if (a === "reading" && (await readingRoute(req, res, method, segs))) return;
    if (a === "scratchpad" && segs.length === 1 && method === "GET") {
      return send(res, 200, await readScratchpad());
    }
    if (a === "scratchpad" && segs.length === 1 && method === "PUT") {
      const body = await readJson(req, MAX_SCRATCHPAD_BODY);
      if (body.type !== "excalidraw" || !Array.isArray(body.elements)) throw new HttpError(400, "Not an Excalidraw scene");
      // Never overwrite a file we couldn't read: it may be a hand edit (or another tool's) mid-way.
      if ((await readScratchpad()).error) return send(res, 409, { error: `${SCRATCHPAD_FILE} could not be read; fix or remove it first` });
      await atomicWrite(path.join(config.notesDir, SCRATCHPAD_FILE), JSON.stringify(body, null, 2));
      return send(res, 200, {});
    }
    if (a === "board" && segs.length === 1 && method === "GET") {
      return send(res, 200, await boardView());
    }
    if (a === "board" && b === "ops" && segs.length === 2 && method === "POST") {
      const op = parseBoardOp(await readJson(req));
      try {
        await board.apply(op);
      } catch (err) {
        if (err instanceof BoardOpError) return send(res, 400, { error: err.message });
        if (err instanceof ConfigFileError) return send(res, 409, { error: err.message });
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (err instanceof Error && typeof code === "string" && /^E[A-Z0-9]+$/.test(code) && !code.startsWith("ERR_")) {
          console.error("board op failed:", err);
          return send(res, 409, { error: "board.yaml could not be read or written" });
        }
        throw err;
      }
      return send(res, 200, await boardView());
    }
    if (a === "board" && b === "refresh" && segs.length === 2 && method === "POST") {
      await board.refresh();
      refresher.scheduleTicketFiles();
      return send(res, 200, await boardView());
    }
    if (a === "events" && segs.length === 1 && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
      ping.unref();
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    throw new HttpError(404, "Not found");
  }

  async function serveStatic(res: http.ServerResponse, method: string, pathname: string): Promise<void> {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "Bad path");
    }
    if (decoded.includes("\0")) throw new HttpError(400, "Bad path");
    const index = path.join(publicDir, "index.html");
    const target = decoded === "/" ? index : path.resolve(publicDir, "." + decoded);
    if (target !== index && !target.startsWith(publicDir + path.sep)) throw new HttpError(404, "Not found");
    let data: Buffer;
    try {
      data = await fs.readFile(target);
    } catch {
      throw new HttpError(404, "Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(method === "HEAD" ? undefined : data);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.message });
        return;
      }
      let status = 500;
      let message = "Internal error";
      if (err instanceof InvalidKeyError) {
        status = 400;
        message = "Invalid ticket key";
      } else if (err instanceof InvalidReadingIdError) {
        status = 400;
        message = "Invalid reading id";
      } else if (err instanceof ConfigFileError) {
        message = err.message;
      } else {
        console.error("request failed:", err);
      }
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!req.headers.host || !hosts.includes(req.headers.host.toLowerCase())) {
      throw new HttpError(421, "Misdirected request");
    }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
        throw new HttpError(403, "Forbidden origin");
      }
      if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
        throw new HttpError(415, "Content-Type must be application/json");
      }
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      let segs: string[];
      try {
        segs = url.pathname.split("/").slice(2).filter((s, i, arr) => !(s === "" && i === arr.length - 1)).map(decodeURIComponent);
      } catch {
        throw new HttpError(400, "Bad path");
      }
      return api(req, res, method, segs);
    }
    return serveStatic(res, method, url.pathname);
  }

  return { server, broadcast };
}
