import type { GroomFile, NoteFile, Row, Ticket } from "../shared/types.ts";

export function buildRow(
  ticket: Ticket,
  note: NoteFile | null,
  groom: GroomFile | null,
  customIds: string[],
): Row {
  const custom: Record<string, string> = {};
  if (note) {
    for (const id of customIds) {
      const v = note.data[id];
      if (v !== undefined && v !== null) custom[id] = String(v);
    }
  }
  const updated = Date.parse(ticket.updated);
  return {
    ticket,
    note: note ? { body: note.body, mtimeMs: note.mtimeMs } : null,
    groom: groom ? groom.summary : null,
    custom,
    flags: {
      jiraNewerThanNote: note ? updated > note.mtimeMs : false,
      jiraNewerThanGroom: groom?.summary.groomedAt ? updated > Date.parse(groom.summary.groomedAt) : false,
    },
  };
}
