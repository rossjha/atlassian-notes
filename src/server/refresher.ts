import type { LiveEvent, Ticket, View } from "../shared/types.ts";
import type { CachedView, ViewCache } from "./cache.ts";
import { JiraError, type JiraClient } from "./jira.ts";
import type { NotesStore } from "./notesStore.ts";
import { reconcile } from "./reconcile.ts";

export interface RefresherDeps {
  jira: JiraClient;
  cache: ViewCache;
  notes: NotesStore;
  getViews: () => Promise<View[]>;
  onChange: (e: LiveEvent) => void;
  statePath: string;
  now?: () => Date;
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
      const tickets = await jira.search(view.jql, view.limit);
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
    const { jira, cache, notes, getViews, onChange, statePath } = this.deps;
    const views = await getViews();
    for (const v of views) await this.refreshView(v);
    const seen = await cache.allTickets(views.map((v) => v.id));
    const { renamed, orphans } = await reconcile({ jira, notes, seen, statePath, now: this.now() });
    for (const [, newKey] of renamed) {
      onChange({ type: "note", key: newKey });
      onChange({ type: "groom", key: newKey });
    }
    if (orphans.join("\n") !== this.orphanKeys.join("\n")) {
      this.orphanKeys = orphans;
      onChange({ type: "orphans" });
    }
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
