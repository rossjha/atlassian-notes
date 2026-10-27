import { isValidKeyClient } from "./rowOps.ts";

const KEY_IN_TEXT = /[A-Z][A-Z0-9_]*-[1-9][0-9]*/gi;

/**
 * The ticket key in what was typed or pasted into the ticket search: a key, a bare number (in `defaultProject`),
 * or a Jira link (`?selectedIssue=`, then `/browse/KEY`, then the last key in the path). Null if there is none.
 */
export function ticketKeyFromInput(input: string, defaultProject: string | null): string | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) {
    const key = defaultProject ? `${defaultProject.toUpperCase()}-${s}` : "";
    return isValidKeyClient(key) ? key : null;
  }
  if (isValidKeyClient(s.toUpperCase())) return s.toUpperCase();
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const selected = url.searchParams.get("selectedIssue")?.toUpperCase();
  if (selected && isValidKeyClient(selected)) return selected;
  const browse = /\/browse\/([^/?#]+)/.exec(url.pathname)?.[1]?.toUpperCase();
  if (browse && isValidKeyClient(browse)) return browse;
  const keys = decodeURIComponent(url.pathname).match(KEY_IN_TEXT);
  const last = keys?.at(-1)?.toUpperCase();
  return last && isValidKeyClient(last) ? last : null;
}

/** The JQL clause a view's keyword search adds: a full-text match on summary, description, comments and text fields. */
export function keywordClause(keyword: string): string {
  return `text ~ "${keyword.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Index where the query's ORDER BY clause starts (ignoring quoted text), or -1. */
function orderByIndex(jql: string): number {
  let masked = "";
  let quote: string | null = null;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i]!;
    if (quote) {
      if (ch === "\\") {
        masked += "  ";
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      masked += " ";
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      masked += ch;
    }
  }
  let found = -1;
  for (const m of masked.matchAll(/\border\s+by\b/gi)) found = m.index;
  return found;
}

/** A query split into its filter and its ORDER BY clause ("" when there is none). */
export function splitOrderBy(jql: string): { where: string; orderBy: string } {
  const at = orderByIndex(jql);
  return at < 0 ? { where: jql.trim(), orderBy: "" } : { where: jql.slice(0, at).trim(), orderBy: jql.slice(at).trim() };
}

/** The view's JQL with its keyword search ANDed in, before any ORDER BY. A blank keyword leaves it unchanged. */
export function withKeyword(jql: string, keyword: string | undefined): string {
  if (!keyword || keyword.trim() === "") return jql;
  const { where, orderBy } = splitOrderBy(jql);
  const order = orderBy ? ` ${orderBy}` : "";
  return where === "" ? `${keywordClause(keyword)}${order}` : `(${where}) AND ${keywordClause(keyword)}${order}`;
}
