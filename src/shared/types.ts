export interface NoteFile {
  key: string;
  data: Record<string, unknown>;
  body: string;
  mtimeMs: number;
  parseError: string | null;
}

export interface GroomSummary {
  readiness: string | null;
  summary: string;
  groomedAt: string | null;
}

export interface GroomFile extends NoteFile {
  summary: GroomSummary;
}

export type BuiltinColumnId =
  | "key" | "summary" | "status" | "type" | "priority" | "assignee" | "reporter"
  | "storyPoints" | "parent" | "labels" | "sprint" | "updated" | "note" | "groom";

export const BUILTIN_COLUMNS: { id: BuiltinColumnId; label: string }[] = [
  { id: "key", label: "Key" },
  { id: "summary", label: "Summary" },
  { id: "status", label: "Status" },
  { id: "type", label: "Type" },
  { id: "priority", label: "Priority" },
  { id: "assignee", label: "Assignee" },
  { id: "reporter", label: "Reporter" },
  { id: "storyPoints", label: "Points" },
  { id: "parent", label: "Parent" },
  { id: "labels", label: "Labels" },
  { id: "sprint", label: "Sprint" },
  { id: "updated", label: "Updated" },
  { id: "note", label: "My note" },
  { id: "groom", label: "Groom" },
];

export interface ColumnSetting {
  id: string;
  hidden?: boolean;
  display?: "truncate" | "expand";
}

export type FilterValue =
  | { op: "oneOf"; values: string[] }
  | { op: "empty" }
  | { op: "notEmpty" }
  | { op: "contains"; text: string };

export type Filters = Record<string, FilterValue>;

export interface View {
  id: string;
  name: string;
  jql: string;
  limit: number;
  columns: ColumnSetting[];
  filters: Filters;
}

export type CustomColumnDef =
  | { label: string; type: "select"; options: Record<string, string> }
  | { label: string; type: "text" };

export interface ColumnsConfig {
  jiraFields: { storyPoints: string | null; sprint: string; acceptanceCriteria: string | null };
  custom: Record<string, CustomColumnDef>;
  groomPrompt: string;
}

export interface Ticket {
  id: string;
  key: string;
  url: string;
  summary: string;
  status: string;
  statusCategory: string;
  type: string;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  storyPoints: number | null;
  parent: { key: string; summary: string } | null;
  labels: string[];
  sprint: string | null;
  updated: string;
}

export interface IssueDetail {
  ticket: Ticket;
  descriptionMd: string;
  acceptanceCriteriaMd: string | null;
  comments: { author: string; created: string; bodyMd: string }[];
}

export interface Row {
  ticket: Ticket;
  note: { body: string; mtimeMs: number } | null;
  groom: GroomSummary | null;
  custom: Record<string, string>;
  flags: { jiraNewerThanNote: boolean; jiraNewerThanGroom: boolean };
}

export interface BoardFile {
  columns: string[];
  archiveColumn: string;
  cards: Record<string, string[]>;
}

export type BoardOp =
  | { op: "add"; key: string }
  | { op: "remove"; key: string }
  | { op: "move"; key: string; column: string; index: number }
  | { op: "archive" };

export type LiveEvent =
  | { type: "rows"; viewId: string }
  | { type: "note" | "groom"; key: string }
  | { type: "views" | "columns" }
  | { type: "orphans" }
  | { type: "board" };
