import type { ColumnsConfig, IssueDetail, Ticket, TicketLink } from "../shared/types.ts";
import { adfToMarkdown } from "./markdown.ts";

export class JiraError extends Error {
  status: number;
  messages: string[];
  constructor(status: number, messages: string[]) {
    super(messages.join("; ") || `Jira request failed (${status})`);
    this.name = "JiraError";
    this.status = status;
    this.messages = messages;
  }
}

export interface JiraClient {
  search(jql: string, limit: number): Promise<Ticket[]>;
  getIssueDetail(idOrKey: string): Promise<IssueDetail>;
  getIssueBrief(idOrKey: string): Promise<{ id: string; key: string } | null>;
}

interface Opts {
  apiBase: string;
  siteUrl: string;
  email: string;
  token: string;
  fields: ColumnsConfig["jiraFields"];
  /** analysis.yaml settings.fields: extra field ids fetched into Ticket.extra (read on every search). */
  extraFields?: () => string[];
  /** analysis.yaml blocked.flagField: Jira's Flagged field id, fetched into Ticket.flagged. */
  flagField?: () => string | null;
}

/** A custom field's value as text: an option's value or name, a string or number, or a list of those joined. */
function fieldText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(fieldText).filter((x): x is string => x !== null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["value", "name", "displayName", "key"]) if (typeof o[k] === "string" && o[k] !== "") return o[k] as string;
  }
  return null;
}

const CATEGORY_KEYS = new Set(["new", "indeterminate", "done"]);

type Json = Record<string, any>;

const BASE_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter", "parent", "labels", "components", "updated", "issuelinks"];

/** Jira's "+0100" offsets sort wrongly as strings and don't parse everywhere; send ISO UTC. Invalid → raw. */
function toIso(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** "fetch failed" alone is undiagnosable: add the underlying cause (ENOTFOUND, ECONNREFUSED, TLS errors…). */
function describeNetworkError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause as { code?: unknown; message?: unknown } | undefined;
  if (!cause || typeof cause !== "object") return e.message;
  const code = typeof cause.code === "string" ? cause.code : "";
  const msg = typeof cause.message === "string" ? cause.message : "";
  const detail = [code, msg].filter(Boolean).join(": ");
  return detail ? `${e.message} (${detail})` : e.message;
}

export function createJiraClient(opts: Opts, fetchFn: typeof fetch = fetch): JiraClient {
  const auth = "Basic " + Buffer.from(`${opts.email}:${opts.token}`).toString("base64");
  const apiBase = opts.apiBase.replace(/\/+$/, "");
  const siteUrl = opts.siteUrl.replace(/\/+$/, "");

  async function get(path: string, params: Record<string, string>): Promise<Json> {
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchFn(url.toString(), { method: "GET", headers: { Authorization: auth, Accept: "application/json" } });
    } catch (e) {
      throw new JiraError(0, [`Could not reach Jira: ${describeNetworkError(e)}`]);
    }
    const text = await res.text();
    if (!res.ok) {
      let messages: string[] = [];
      try {
        const body = JSON.parse(text);
        messages = [
          ...(Array.isArray(body?.errorMessages) ? body.errorMessages.map(String) : []),
          ...Object.values(body?.errors ?? {}).map(String),
          ...(typeof body?.message === "string" && body.message ? [body.message] : []),
        ];
      } catch {
        // not JSON
      }
      if (messages.length === 0) messages = [res.statusText || `HTTP ${res.status}`];
      throw new JiraError(res.status, messages);
    }
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new JiraError(res.status, ["Jira returned an invalid response"]);
    }
  }

  const extraIds = (): string[] => opts.extraFields?.() ?? [];
  const flagId = (): string | null => opts.flagField?.() ?? null;

  function fieldList(extra: string[] = []): string {
    const f = [...BASE_FIELDS, ...extra, ...extraIds()];
    const flag = flagId();
    if (flag) f.push(flag);
    if (opts.fields.storyPoints) f.push(opts.fields.storyPoints);
    f.push(opts.fields.sprint);
    return [...new Set(f)].join(",");
  }

  function mapTicket(issue: Json): Ticket {
    const f: Json = issue.fields ?? {};
    const sp = opts.fields.storyPoints ? f[opts.fields.storyPoints] : null;
    const sprints: Json[] = Array.isArray(f[opts.fields.sprint]) ? f[opts.fields.sprint] : [];
    const links: TicketLink[] = [];
    for (const l of Array.isArray(f.issuelinks) ? f.issuelinks : []) {
      // Jira words the relationship from this ticket's side: outward phrase for outwardIssue, inward for inwardIssue.
      const out = l?.outwardIssue, inn = l?.inwardIssue;
      const link = (other: Json, type: unknown, direction: "inward" | "outward"): TicketLink => {
        const cat = other?.fields?.status?.statusCategory?.key;
        return { type: String(type ?? ""), direction, key: other.key, ...(typeof cat === "string" ? { done: cat === "done" } : {}) };
      };
      if (typeof out?.key === "string") links.push(link(out, l.type?.outward, "outward"));
      else if (typeof inn?.key === "string") links.push(link(inn, l.type?.inward, "inward"));
    }
    const sprint = sprints.find((s) => s?.state === "active") ?? sprints[sprints.length - 1];
    const catKey = f.status?.statusCategory?.key;
    const extra = opts.extraFields ? Object.fromEntries(extraIds().map((id) => [id, fieldText(f[id])])) : null;
    const flag = flagId();
    return {
      id: String(issue.id),
      key: issue.key,
      url: `${siteUrl}/browse/${issue.key}`,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      statusCategory: f.status?.statusCategory?.name ?? "",
      type: f.issuetype?.name ?? "",
      priority: f.priority?.name ?? null,
      assignee: f.assignee?.displayName ?? null,
      reporter: f.reporter?.displayName ?? null,
      storyPoints: typeof sp === "number" ? sp : null,
      parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? "" } : null,
      labels: Array.isArray(f.labels) ? f.labels : [],
      components: Array.isArray(f.components)
        ? f.components.map((c: Json) => c?.name).filter((n: unknown): n is string => typeof n === "string")
        : [],
      sprint: sprint?.name ?? null,
      sprints: sprints
        .filter((s) => typeof s?.name === "string")
        .map((s) => ({
          name: s.name as string,
          state: typeof s.state === "string" ? s.state : "",
          ...(typeof s.startDate === "string" && s.startDate ? { startDate: toIso(s.startDate) } : {}),
          ...(typeof s.endDate === "string" && s.endDate ? { endDate: toIso(s.endDate) } : {}),
        })),
      links,
      ...(CATEGORY_KEYS.has(catKey) ? { statusCategoryKey: catKey } : {}),
      ...(extra ? { extra } : {}),
      ...(flag ? { flagged: fieldText(f[flag]) !== null } : {}),
      updated: toIso(f.updated),
    };
  }

  return {
    async search(jql, limit) {
      const out: Ticket[] = [];
      let token: string | undefined;
      while (out.length < limit) {
        const params: Record<string, string> = {
          jql,
          fields: fieldList(),
          maxResults: String(Math.min(100, limit - out.length)),
        };
        if (token) params.nextPageToken = token;
        const body = await get("/rest/api/3/search/jql", params);
        const issues: Json[] = Array.isArray(body.issues) ? body.issues : [];
        for (const issue of issues) {
          if (out.length >= limit) break;
          out.push(mapTicket(issue));
        }
        if (body.isLast || !body.nextPageToken || issues.length === 0) break;
        token = body.nextPageToken;
      }
      return out;
    },

    async getIssueDetail(idOrKey) {
      const ac = opts.fields.acceptanceCriteria;
      const extra = ["description", "comment", ...(ac ? [ac] : [])];
      const issue = await get(`/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields: fieldList(extra) });
      const f: Json = issue.fields ?? {};
      const comments: Json[] = Array.isArray(f.comment?.comments) ? f.comment.comments : [];
      return {
        ticket: mapTicket(issue),
        descriptionMd: adfToMarkdown(f.description),
        acceptanceCriteriaMd: ac && f[ac] != null ? adfToMarkdown(f[ac]) : null,
        comments: comments.map((c) => ({
          author: c.author?.displayName ?? "Unknown",
          created: toIso(c.created),
          bodyMd: adfToMarkdown(c.body),
        })),
      };
    },

    async getIssueBrief(idOrKey) {
      try {
        const issue = await get(`/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields: "summary" });
        return { id: String(issue.id), key: issue.key };
      } catch (e) {
        if (e instanceof JiraError && e.status === 404) return null;
        throw e;
      }
    },
  };
}
