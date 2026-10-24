import fs from "node:fs/promises";
import path from "node:path";
import type { Ticket } from "../shared/types.ts";
import { atomicWrite } from "./notesStore.ts";

export interface CachedView {
  fetchedAt: string | null;
  tickets: Ticket[];
  error: string | null;
}

export class ViewCache {
  private dir: string;

  constructor(notesDir: string) {
    this.dir = path.join(path.resolve(notesDir), ".cache", "views");
  }

  private file(viewId: string): string {
    return path.join(this.dir, `${viewId}.json`);
  }

  async read(viewId: string): Promise<CachedView> {
    try {
      const v = JSON.parse(await fs.readFile(this.file(viewId), "utf8"));
      if (v && Array.isArray(v.tickets)) {
        return {
          fetchedAt: typeof v.fetchedAt === "string" ? v.fetchedAt : null,
          tickets: v.tickets,
          error: typeof v.error === "string" ? v.error : null,
        };
      }
    } catch {
      // missing or corrupt
    }
    return { fetchedAt: null, tickets: [], error: null };
  }

  async write(viewId: string, v: CachedView): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.file(viewId), JSON.stringify(v));
  }

  async allTickets(viewIds: string[]): Promise<Map<string, Ticket>> {
    const out = new Map<string, Ticket>();
    for (const id of viewIds) {
      for (const t of (await this.read(id)).tickets) out.set(t.key, t);
    }
    return out;
  }

  /** Every ticket in every cache file (views and the board). Later files win on duplicate keys. */
  async allCachedTickets(): Promise<{ tickets: Map<string, Ticket>; cacheFiles: number }> {
    const tickets = new Map<string, Ticket>();
    let cacheFiles = 0;
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return { tickets, cacheFiles };
    }
    for (const name of names) {
      try {
        const v = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8"));
        if (!v || !Array.isArray(v.tickets)) continue;
        cacheFiles++;
        for (const t of v.tickets as Ticket[]) {
          if (t && typeof t.key === "string") tickets.set(t.key, t);
        }
      } catch {
        // missing or corrupt
      }
    }
    return { tickets, cacheFiles };
  }
}
