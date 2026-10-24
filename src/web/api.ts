import type { ColumnsConfig, Row, View } from "../shared/types.ts";

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

export const api = {
  async config(): Promise<ConfigResponse> {
    return (await request("GET", "/api/config")).json() as Promise<ConfigResponse>;
  },
  async rows(viewId: string): Promise<RowsResponse> {
    return (await request("GET", `/api/views/${encodeURIComponent(viewId)}/rows`)).json() as Promise<RowsResponse>;
  },
  async refresh(viewId: string): Promise<RowsResponse> {
    return (await request("POST", `/api/views/${encodeURIComponent(viewId)}/refresh`)).json() as Promise<RowsResponse>;
  },
  async copyPrompt(key: string): Promise<string> {
    return (await request("GET", `/api/tickets/${encodeURIComponent(key)}/copy/prompt`)).text();
  },
};
