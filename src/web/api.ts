import type { BoardOp, BoardResponse, ColumnsConfig, GroomFile, IssueDetail, NoteFile, Row, View } from "../shared/types.ts";

export interface ConfigResponse {
  views: View[];
  columns: ColumnsConfig;
  jiraBaseUrl: string;
  error: string | null;
}

export interface RowsResponse {
  rows: Row[];
  fetchedAt: string | null;
  error: string | null;
}

export type CopyKind = "ticket" | "notes" | "both" | "prompt";

export interface TicketResponse {
  detail: IssueDetail;
  html: { description: string; acceptanceCriteria: string; comments: string[] };
  note: NoteFile | null;
  noteHtml: string;
  groom: GroomFile | null;
  groomHtml: string;
  groomPath: string;
}

export interface Orphan {
  key: string;
  notePath: string;
  groomPath: string;
}

async function request(method: string, url: string): Promise<Response> {
  const init: RequestInit = method === "GET" ? {} : { method, headers: { "Content-Type": "application/json" }, body: "{}" };
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // keep status text
    }
    throw new Error(msg);
  }
  return res;
}

async function postJson(url: string, payload: unknown): Promise<Response> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (res.ok) return res;
  const b = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(b.error ?? `${res.status} ${res.statusText}`);
}

export type SaveResult =
  | { kind: "ok"; mtimeMs: number }
  | { kind: "conflict"; current: NoteFile }
  | { kind: "invalid"; error: string };

async function put(url: string, payload: unknown): Promise<Response> {
  return fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

async function saveResult(res: Response): Promise<SaveResult> {
  const body = (await res.json().catch(() => ({}))) as { mtimeMs?: number; current?: NoteFile; error?: string };
  if (res.ok && typeof body.mtimeMs === "number") return { kind: "ok", mtimeMs: body.mtimeMs };
  if (res.status === 409 && body.current) return { kind: "conflict", current: body.current };
  throw new Error(body.error ?? `${res.status} ${res.statusText}`);
}

export const api = {
  /** 422 (unparseable front matter) comes back as kind "invalid"; other failures throw. */
  async saveNote(key: string, body: string, baseMtimeMs: number | null, force = false): Promise<SaveResult> {
    const res = await put(`/api/notes/${encodeURIComponent(key)}`, { body, baseMtimeMs, ...(force ? { force: true } : {}) });
    if (res.status === 422) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return { kind: "invalid", error: b.error ?? "Note could not be parsed" };
    }
    return saveResult(res);
  },
  async setField(key: string, field: string, value: string | null): Promise<SaveResult> {
    const res = await put(`/api/notes/${encodeURIComponent(key)}/fields/${encodeURIComponent(field)}`, { value });
    if (res.status === 422) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return { kind: "invalid", error: b.error ?? "Note could not be parsed" };
    }
    return saveResult(res);
  },
  async saveViews(views: View[]): Promise<void> {
    const res = await put("/api/views", { views });
    if (res.ok) return;
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `${res.status} ${res.statusText}`);
  },
  async config(): Promise<ConfigResponse> {
    return (await request("GET", "/api/config")).json() as Promise<ConfigResponse>;
  },
  async rows(viewId: string): Promise<RowsResponse> {
    return (await request("GET", `/api/views/${encodeURIComponent(viewId)}/rows`)).json() as Promise<RowsResponse>;
  },
  async refresh(viewId: string): Promise<RowsResponse> {
    return (await request("POST", `/api/views/${encodeURIComponent(viewId)}/refresh`)).json() as Promise<RowsResponse>;
  },
  async copy(key: string, kind: CopyKind): Promise<string> {
    return (await request("GET", `/api/tickets/${encodeURIComponent(key)}/copy/${kind}`)).text();
  },
  copyPrompt(key: string): Promise<string> {
    return api.copy(key, "prompt");
  },
  async ticket(key: string): Promise<TicketResponse> {
    return (await request("GET", `/api/tickets/${encodeURIComponent(key)}`)).json() as Promise<TicketResponse>;
  },
  async board(): Promise<BoardResponse> {
    return (await request("GET", "/api/board")).json() as Promise<BoardResponse>;
  },
  async boardOp(op: BoardOp): Promise<BoardResponse> {
    return (await postJson("/api/board/ops", op)).json() as Promise<BoardResponse>;
  },
  async refreshBoard(): Promise<BoardResponse> {
    return (await request("POST", "/api/board/refresh")).json() as Promise<BoardResponse>;
  },
  async orphans(): Promise<Orphan[]> {
    return ((await (await request("GET", "/api/orphans")).json()) as { orphans: Orphan[] }).orphans;
  },
};
