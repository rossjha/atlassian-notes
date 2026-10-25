// Reading list helpers shared by server and web: URL checks, title guessing, ids, filtering and sorting.
// No Node imports: the web build compiles src/shared too.
import type { ReadingItem, ReadingSource } from "./types.ts";

/** Prefix of a reading item's card in board.yaml (ticket cards are bare keys). */
export const READING_PREFIX = "reading:";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_ID = 80;

export function isReadingId(id: string): boolean {
  return ID_RE.test(id);
}

export function readingCardKey(id: string): string {
  return `${READING_PREFIX}${id}`;
}

export function readingIdFromCard(card: string): string | null {
  if (!card.startsWith(READING_PREFIX)) return null;
  const id = card.slice(READING_PREFIX.length);
  return isReadingId(id) ? id : null;
}

/** The URL in one canonical form (for duplicate checks), or null unless it is http(s). */
export function normaliseUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // URL already lower-cases the host. Drop one trailing slash from a non-root path when nothing follows it.
  if (!u.search && !u.hash && u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "loom.com"];

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function lastSegment(u: URL): string | null {
  const segs = u.pathname.split("/").filter(Boolean);
  return segs.length ? decodeSegment(segs[segs.length - 1]) : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A starting title and the kind of source, from the URL alone (the app never fetches the page). */
export function guessFromUrl(url: string, jiraBaseUrl: string | null): { title: string; source: ReadingSource } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { title: url, source: "web" };
  }
  const host = u.host.toLowerCase();
  const bare = host.replace(/^www\./, "");
  if (u.pathname.startsWith("/wiki/") && (host === hostOf(jiraBaseUrl) || host.endsWith(".atlassian.net"))) {
    const m = /^\/wiki\/spaces\/[^/]+\/pages\/[^/]+\/([^/]+)/.exec(u.pathname);
    if (m) return { title: decodeSegment(m[1]), source: "confluence" };
    const last = lastSegment(u);
    return { title: last ? `${host}: ${last}` : host, source: "confluence" };
  }
  if (bare === "slack.com" || bare.endsWith(".slack.com")) return { title: "Slack thread", source: "slack" };
  const isVideo =
    VIDEO_HOSTS.some((v) => bare === v || bare.endsWith(`.${v}`)) ||
    (bare.includes("stream") && (bare.includes("microsoft") || bare.includes("sharepoint")));
  const last = lastSegment(u);
  if (isVideo) return { title: last ? `Video: ${last}` : "Video", source: "video" };
  return { title: last ? `${host}: ${last}` : host, source: "web" };
}

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `<created date>-<slug of the title>`, unique against `taken`, at most 80 characters. */
export function makeReadingId(createdIso: string, title: string, taken: ReadonlySet<string>): string {
  const base = `${createdIso.slice(0, 10)}-${slug(title) || "item"}`;
  const fit = (s: string, room: number) => s.slice(0, room).replace(/-+$/, "");
  const first = fit(base, MAX_ID);
  if (!taken.has(first)) return first;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${fit(base, MAX_ID - suffix.length)}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

export function filterReading(
  items: ReadingItem[],
  f: { status: string | null; category: string | null; ticket: string | null },
): ReadingItem[] {
  return items.filter(
    (i) =>
      (f.status === null || i.status === f.status) &&
      (f.category === null || i.category === f.category) &&
      (f.ticket === null || i.tickets.includes(f.ticket)),
  );
}

export type ReadingSortKey = "title" | "status" | "category" | "tickets" | "groomed" | "updated" | "created";

function sortValue(i: ReadingItem, by: ReadingSortKey): string | null {
  switch (by) {
    case "title":
      return i.title.toLowerCase();
    case "status":
      return i.status.toLowerCase();
    case "category":
      return i.category?.toLowerCase() ?? null;
    case "tickets":
      return i.tickets.length ? i.tickets.join(",") : null;
    case "groomed":
      return i.groom?.groomedAt ?? null;
    case "updated":
      return i.updated;
    case "created":
      return i.created;
  }
}

/** Stable sort; items with no value for the column always sort last. */
export function sortReading(items: ReadingItem[], by: ReadingSortKey, dir: "asc" | "desc"): ReadingItem[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((x, y) => {
    const a = sortValue(x, by);
    const b = sortValue(y, by);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return a < b ? -sign : a > b ? sign : 0;
  });
}
