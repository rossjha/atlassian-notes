import type { GroomFile, IssueDetail, NoteFile, ReadingItem } from "../shared/types.ts";

export function ticketMarkdown(d: IssueDetail): string {
  const t = d.ticket;
  const parts = [
    `# ${t.key}: ${t.summary}\n${t.url}\n\n- Status: ${t.status}\n- Type: ${t.type}\n- Story points: ${t.storyPoints ?? "–"}`,
    `## Description\n${d.descriptionMd || "_None_"}`,
  ];
  if (d.acceptanceCriteriaMd !== null) parts.push(`## Acceptance criteria\n${d.acceptanceCriteriaMd}`);
  if (d.comments.length > 0) {
    const cs = d.comments.map((c) => `### ${c.author} — ${c.created.slice(0, 10)}\n${c.bodyMd}`);
    parts.push(`## Comments\n${cs.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

export function bothMarkdown(d: IssueDetail, note: NoteFile | null, groom: GroomFile | null): string {
  return `${ticketMarkdown(d)}\n\n# My notes\n${note?.body || "_None_"}\n\n# Groom output\n${groom?.body || "_None_"}`;
}

export function groomPrompt(template: string, vars: { key: string; url: string; groomPath: string }): string {
  return template
    .replaceAll("{key}", () => vars.key)
    .replaceAll("{url}", () => vars.url)
    .replaceAll("{groomPath}", () => vars.groomPath);
}

export function readingLinkMarkdown(item: ReadingItem): string {
  return `[${item.title}](${item.url})`;
}

export function readingBothMarkdown(item: ReadingItem, groomBody: string | null): string {
  let out =
    `# ${item.title}\n${item.url}\n\n- Status: ${item.status}\n- Category: ${item.category ?? "–"}\n` +
    `- Tickets: ${item.tickets.length ? item.tickets.join(", ") : "none"}\n\n## My note\n${item.note || "_None_\n"}`;
  if (groomBody !== null) out += `\n## Claude summary\n${groomBody}`;
  return out;
}

export function readingPrompt(
  template: string,
  vars: { url: string; title: string; tickets: string; groomPath: string; notePath: string },
): string {
  return template
    .replaceAll("{url}", () => vars.url)
    .replaceAll("{title}", () => vars.title)
    .replaceAll("{tickets}", () => vars.tickets)
    .replaceAll("{groomPath}", () => vars.groomPath)
    .replaceAll("{notePath}", () => vars.notePath);
}
