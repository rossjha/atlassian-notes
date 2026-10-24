import fs from "node:fs/promises";
import type { Ticket } from "../shared/types.ts";
import { JiraError, type JiraClient } from "./jira.ts";
import { atomicWrite, type NotesStore } from "./notesStore.ts";

interface State {
  checked: Record<string, { at: string; orphan: boolean }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadState(statePath: string): Promise<State> {
  try {
    const s = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (s && typeof s.checked === "object" && s.checked !== null && !Array.isArray(s.checked)) {
      return { checked: s.checked };
    }
  } catch {
    // missing or corrupt
  }
  return { checked: {} };
}

export async function reconcile(deps: {
  jira: JiraClient;
  notes: NotesStore;
  seen: Map<string, Ticket>;
  statePath: string;
  now: Date;
}): Promise<{ renamed: [string, string][]; orphans: string[] }> {
  const { jira, notes, seen, statePath, now } = deps;
  const state = await loadState(statePath);
  const { notes: noteFiles, grooms } = await notes.listAll();

  const unseen = new Map<string, string | null>(); // key -> jira_id
  for (const f of [...noteFiles, ...grooms]) {
    if (seen.has(f.key)) continue;
    const id = typeof f.data.jira_id === "string" && f.data.jira_id !== "" ? f.data.jira_id : null;
    if (!unseen.has(f.key) || (unseen.get(f.key) === null && id !== null)) unseen.set(f.key, id);
  }

  const byId = new Map<string, Ticket>();
  for (const t of seen.values()) byId.set(t.id, t);

  const renamed: [string, string][] = [];
  const orphanKeys = new Set<string>();
  const nowIso = now.toISOString();

  const tryRename = async (key: string, target: string): Promise<void> => {
    const res = await notes.renameKey(key, target);
    if (res === "renamed") {
      renamed.push([key, target]);
      delete state.checked[key];
    } else if (res === "target-exists") {
      state.checked[key] = { at: nowIso, orphan: true };
      orphanKeys.add(key);
    }
  };

  try {
    for (const key of [...unseen.keys()].sort()) {
      const jiraId = unseen.get(key) ?? null;
      const prev = state.checked[key];
      try {
        const match = jiraId !== null ? byId.get(jiraId) : undefined;
        if (match) {
          await tryRename(key, match.key);
          continue;
        }

        if (prev && now.getTime() >= new Date(prev.at).getTime() && now.getTime() - new Date(prev.at).getTime() < DAY_MS) {
          if (prev.orphan) orphanKeys.add(key);
          continue;
        }

        try {
          const brief = await jira.getIssueBrief(jiraId ?? key);
          if (brief === null) {
            state.checked[key] = { at: nowIso, orphan: true };
            orphanKeys.add(key);
          } else if (brief.key !== key) {
            await tryRename(key, brief.key);
          } else {
            state.checked[key] = { at: nowIso, orphan: false };
          }
        } catch (e) {
          if (e instanceof JiraError && e.status === 404) {
            state.checked[key] = { at: nowIso, orphan: true };
            orphanKeys.add(key);
          } else {
            throw e;
          }
        }
      } catch {
        // skip this key this round; keep its previous state
        if (prev?.orphan) orphanKeys.add(key);
      }
    }
  } finally {
    // forget checks for keys that no longer have files
    for (const key of Object.keys(state.checked)) {
      if (!unseen.has(key)) delete state.checked[key];
    }
    await atomicWrite(statePath, JSON.stringify(state));
  }

  return { renamed, orphans: [...orphanKeys].sort() };
}
