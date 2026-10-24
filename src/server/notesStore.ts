import fs from "node:fs/promises";
import path from "node:path";
import type { GroomFile, GroomSummary, NoteFile } from "../shared/types.ts";
import { InvalidKeyError, isValidKey, parseFrontMatter, stringifyFrontMatter } from "./frontMatter.ts";

export { InvalidKeyError };

export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: NoteFile | null; reason: "conflict" | "parse-error" };

type Kind = "notes" | "groom";

export async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

function summarise(file: NoteFile): GroomSummary {
  const { data, body, mtimeMs } = file;
  let summary = typeof data.summary === "string" ? data.summary : "";
  if (!summary) {
    const line = body.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
    summary = line.replace(/^\s*#+\s*/, "").trim();
  }
  return {
    readiness: typeof data.readiness === "string" ? data.readiness : null,
    summary,
    groomedAt: scalarToIso(data.groomed_at) ?? new Date(mtimeMs).toISOString(),
  };
}

function scalarToIso(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (v instanceof Date) return v.toISOString();
  return null;
}

export class NotesStore {
  readonly notesDir: string;

  constructor(notesDir: string) {
    this.notesDir = path.resolve(notesDir);
  }

  notePath(key: string): string {
    return this.pathFor("notes", key);
  }

  groomPath(key: string): string {
    return this.pathFor("groom", key);
  }

  async readNote(key: string): Promise<NoteFile | null> {
    return this.readFile("notes", key);
  }

  async readGroom(key: string): Promise<GroomFile | null> {
    const file = await this.readFile("groom", key);
    return file ? { ...file, summary: summarise(file) } : null;
  }

  async writeNoteBody(
    key: string,
    body: string,
    opts: { baseMtimeMs: number | null; jiraId?: string; force?: boolean },
  ): Promise<WriteResult> {
    const file = this.notePath(key);
    const existing = await this.readFile("notes", key);
    if (!existing) {
      const data: Record<string, unknown> = { key };
      if (opts.jiraId !== undefined) data.jira_id = opts.jiraId;
      return this.write(file, stringifyFrontMatter(data, body));
    }
    if (!opts.force && opts.baseMtimeMs !== existing.mtimeMs) {
      return { ok: false, conflict: existing, reason: "conflict" };
    }
    if (existing.parseError) {
      return { ok: false, conflict: existing, reason: "parse-error" };
    }
    const data = { ...existing.data };
    data.key = key;
    if (opts.jiraId !== undefined) data.jira_id = opts.jiraId;
    return this.write(file, stringifyFrontMatter(data, body));
  }

  async setNoteField(
    key: string,
    field: string,
    value: string | null,
    jiraId?: string,
  ): Promise<WriteResult> {
    const file = this.notePath(key);
    const existing = await this.readFile("notes", key);
    if (existing?.parseError) {
      return { ok: false, conflict: existing, reason: "parse-error" };
    }
    const data: Record<string, unknown> = { ...(existing?.data ?? {}) };
    data.key = key;
    if (jiraId !== undefined) data.jira_id = jiraId;
    if (value === null) delete data[field];
    else data[field] = value;
    return this.write(file, stringifyFrontMatter(data, existing?.body ?? ""));
  }

  async ensureIdentity(key: string, jiraId: string): Promise<void> {
    this.assertKey(key);
    for (const kind of ["notes", "groom"] as const) {
      const existing = await this.readFile(kind, key);
      if (!existing || existing.parseError) continue;
      if (existing.data.key === key && existing.data.jira_id === jiraId) continue;
      const data = { ...existing.data, key, jira_id: jiraId };
      await this.write(this.pathFor(kind, key), stringifyFrontMatter(data, existing.body));
    }
  }

  async renameKey(oldKey: string, newKey: string): Promise<"renamed" | "target-exists" | "missing"> {
    this.assertKey(oldKey);
    this.assertKey(newKey);
    const kinds: Kind[] = ["notes", "groom"];
    const sources: Kind[] = [];
    for (const kind of kinds) {
      if (await this.exists(this.pathFor(kind, oldKey))) sources.push(kind);
    }
    if (sources.length === 0) return "missing";
    for (const kind of sources) {
      if (await this.exists(this.pathFor(kind, newKey))) return "target-exists";
    }
    for (const kind of sources) {
      await fs.mkdir(path.dirname(this.pathFor(kind, newKey)), { recursive: true });
      await fs.rename(this.pathFor(kind, oldKey), this.pathFor(kind, newKey));
      const moved = await this.readFile(kind, newKey);
      if (moved && !moved.parseError) {
        const data = { ...moved.data, key: newKey };
        await this.write(this.pathFor(kind, newKey), stringifyFrontMatter(data, moved.body));
      }
    }
    return "renamed";
  }

  async listAll(): Promise<{ notes: NoteFile[]; grooms: GroomFile[] }> {
    const notes: NoteFile[] = [];
    const grooms: GroomFile[] = [];
    for (const key of await this.listKeys("notes")) {
      const f = await this.readNote(key);
      if (f) notes.push(f);
    }
    for (const key of await this.listKeys("groom")) {
      const f = await this.readGroom(key);
      if (f) grooms.push(f);
    }
    return { notes, grooms };
  }

  private async listKeys(kind: Kind): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.notesDir, "jira", kind));
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
    return names
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3))
      .filter(isValidKey)
      .sort();
  }

  private assertKey(key: string): void {
    if (!isValidKey(key)) throw new InvalidKeyError(key);
  }

  private pathFor(kind: Kind, key: string): string {
    this.assertKey(key);
    return path.join(this.notesDir, "jira", kind, `${key}.md`);
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await fs.stat(file);
      return true;
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  }

  private async readFile(kind: Kind, key: string): Promise<NoteFile | null> {
    const file = this.pathFor(kind, key);
    let text: string;
    let mtimeMs: number;
    try {
      text = await fs.readFile(file, "utf8");
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    const doc = parseFrontMatter(text);
    return { key, data: doc.data, body: doc.body, mtimeMs, parseError: doc.error };
  }

  private async write(file: string, content: string): Promise<WriteResult> {
    await atomicWrite(file, content);
    return { ok: true, mtimeMs: (await fs.stat(file)).mtimeMs };
  }
}
