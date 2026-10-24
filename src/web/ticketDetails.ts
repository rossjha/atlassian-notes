import type { Ticket } from "../shared/types.ts";

/** Issue links grouped by Jira's phrase for this ticket's side ("blocks", "is blocked by"), in first-seen order. */
export function groupLinks(t: Ticket): { phrase: string; keys: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const l of t.links ?? []) {
    const keys = groups.get(l.type) ?? [];
    if (!keys.includes(l.key)) keys.push(l.key);
    groups.set(l.type, keys);
  }
  return [...groups].map(([phrase, keys]) => ({ phrase, keys }));
}

/** The sprint to show: the active one, else the latest listed, else the legacy single value. */
export function sprintLabel(t: Ticket): string | null {
  const sprints = t.sprints ?? [];
  const active = sprints.find((s) => s.state.toLowerCase() === "active");
  return (active ?? sprints.at(-1))?.name ?? t.sprint;
}
