import { withKeyword } from "../shared/search.ts";
import type { LiveEvent, Ticket, View } from "../shared/types.ts";
import type { CachedView, ViewCache } from "./cache.ts";
import { JiraError, type JiraClient } from "./jira.ts";
import type { NotesStore } from "./notesStore.ts";
import { reconcile } from "./reconcile.ts";
import type { TicketFileSyncer } from "./ticketFiles.ts";

export interface RefresherDeps {
  jira: JiraClient;
  cache: ViewCache;
  notes: NotesStore;
  getViews: () => Promise<View[]>;
  onChange: (e: LiveEvent) => void;
  statePath: string;
  now?: () => Date;
  ticketFiles?: TicketFileSyncer;
  board?: {
    refresh(): Promise<void>;
    tickets(): Promise<Map<string, Ticket>>;
    rename(oldKey: string, newKey: string): Promise<void>;
  };
  /** A ticket moved to a new key (reconcile found it): lets the reading list follow. */
  onTicketRenamed?: (oldKey: string, newKey: string) => Promise<void>;
}

export class Refresher {
  private deps: RefresherDeps;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private orphanKeys: string[] = [];

  constructor(deps: RefresherDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async refreshView(view: View): Promise<CachedView> {
    const { jira, cache, notes, onChange } = this.deps;
    let result: CachedView;
    try {
      const tickets = await jira.search(withKeyword(view.jql, view.search), view.limit);
      result = { fetchedAt: this.now().toISOString(), tickets, error: null };
      await cache.write(view.id, result);
      await this.ensureIdentities(tickets);
    } catch (e) {
      const messages = e instanceof JiraError ? e.messages : [e instanceof Error ? e.message : String(e)];
      const prev = await cache.read(view.id);
      result = { fetchedAt: prev.fetchedAt, tickets: prev.tickets, error: messages.join("; ") };
      await cache.write(view.id, result);
    }
    onChange({ type: "rows", viewId: view.id });
    return result;
  }

  private async ensureIdentities(tickets: Ticket[]): Promise<void> {
    for (const t of tickets) {
      try {
        await this.deps.notes.ensureIdentity(t.key, t.id);
      } catch {
        // invalid key or unreadable file: leave it alone
      }
    }
  }

  refreshAll(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.runAll().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async runAll(): Promise<void> {
    try {
      await this.refreshAndReconcile();
    } finally {
      // A broken views file must not leave ticket files stale; sync failures are logged by the syncer.
      await this.deps.ticketFiles?.sync();
    }
  }

  private async refreshAndReconcile(): Promise<void> {
    const { jira, cache, notes, getViews, onChange, statePath, board } = this.deps;
    const views = await getViews();
    for (const v of views) {
      try {
        await this.refreshView(v);
      } catch (e) {
        console.error(`refresh of view ${v.id} failed:`, e instanceof Error ? e.message : e);
      }
    }
    if (board) {
      try {
        await board.refresh();
      } catch (e) {
        console.error("refresh of board failed:", e instanceof Error ? e.message : e);
      }
    }
    const seen = await cache.allTickets(views.map((v) => v.id));
    if (board) for (const [k, tk] of await board.tickets()) seen.set(k, tk);
    const { renamed, orphans } = await reconcile({ jira, notes, seen, statePath, now: this.now() });
    for (const [oldKey, newKey] of renamed) {
      if (board) {
        try {
          await board.rename(oldKey, newKey);
        } catch (e) {
          console.error(`board rename ${oldKey} -> ${newKey} failed:`, e instanceof Error ? e.message : e);
        }
      }
      if (this.deps.onTicketRenamed) {
        try {
          await this.deps.onTicketRenamed(oldKey, newKey);
        } catch (e) {
          console.error(`reading rename ${oldKey} -> ${newKey} failed:`, e instanceof Error ? e.message : e);
        }
      }
      onChange({ type: "note", key: newKey });
      onChange({ type: "groom", key: newKey });
    }
    if (orphans.join("\n") !== this.orphanKeys.join("\n")) {
      this.orphanKeys = orphans;
      onChange({ type: "orphans" });
    }
  }

  scheduleTicketFiles(): void {
    this.deps.ticketFiles?.schedule();
  }

  start(minutes: number): void {
    this.stop();
    const tick = () => {
      this.refreshAll().catch(() => {});
    };
    this.timer = setInterval(tick, minutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  orphans(): string[] {
    return [...this.orphanKeys];
  }
}
