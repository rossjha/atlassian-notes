import fs from "node:fs";
import type { LiveEvent } from "../shared/types.ts";
import { isReadingId } from "../shared/reading.ts";
import { isValidKey } from "./frontMatter.ts";

const DEBOUNCE_MS = 150;

export function eventForPath(rel: string): LiveEvent | null {
  const p = rel.split(/[\\/]/).join("/");
  if (p.startsWith(".cache/") || p === ".cache" || p.includes(".tmp-")) return null;
  if (p === "views.yaml") return { type: "views" };
  if (p === "columns.yaml") return { type: "columns" };
  if (p === "board.yaml") return { type: "board" };
  if (p === "links.yaml") return { type: "links" };
  if (p === "reading.yaml") return { type: "readingConfig" };
  const r = /^reading\/(items|groom)\/(.+)\.md$/.exec(p);
  if (r && isReadingId(r[2])) return { type: r[1] === "items" ? "reading" : "readingGroom", id: r[2] };
  const m = /^jira\/(notes|groom)\/(.+)\.md$/.exec(p);
  if (m && isValidKey(m[2])) return { type: m[1] === "notes" ? "note" : "groom", key: m[2] };
  return null;
}

export function watchNotesDir(notesDir: string, onEvent: (e: LiveEvent) => void): () => void {
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher = fs.watch(notesDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString();
    const ev = eventForPath(rel);
    if (!ev) return;
    clearTimeout(timers.get(rel));
    timers.set(
      rel,
      setTimeout(() => {
        timers.delete(rel);
        onEvent(ev);
      }, DEBOUNCE_MS),
    );
  });
  watcher.on("error", (e) => console.error("file watcher error:", e.message));
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
