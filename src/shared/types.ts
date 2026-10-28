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
  | "storyPoints" | "parent" | "labels" | "components" | "sprint" | "updated" | "note" | "groom"
  | "noteUpdated" | "groomed";

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
  { id: "components", label: "Components" },
  { id: "sprint", label: "Sprint" },
  { id: "updated", label: "Updated" },
  { id: "note", label: "My note" },
  { id: "groom", label: "Groom" },
  { id: "noteUpdated", label: "Note updated" },
  { id: "groomed", label: "Groomed" },
];

export interface ColumnSetting {
  id: string;
  hidden?: boolean;
  display?: "truncate" | "expand";
  /** Explicit column width in whole px; absent = automatic width. */
  width?: number;
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
  /** Keyword search from the box beside the JQL bar; refreshes add `AND text ~ "<search>"` (see shared/search.ts). */
  search?: string;
}

export type CustomColumnDef =
  | { label: string; type: "select"; options: Record<string, string> }
  | { label: string; type: "text" };

export interface ColumnsConfig {
  jiraFields: { storyPoints: string | null; sprint: string; acceptanceCriteria: string | null };
  custom: Record<string, CustomColumnDef>;
  groomPrompt: string;
}

/** `done`: the linked ticket's status category is done (absent in caches written before it was fetched). */
export interface TicketLink { type: string; direction: "inward" | "outward"; key: string; done?: boolean }
export interface TicketSprint { name: string; state: string; startDate?: string; endDate?: string }

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
  // Optional: caches written before these existed lack them. The Jira client always sets them.
  components?: string[];
  sprints?: TicketSprint[];
  links?: TicketLink[];
  /** Jira's status category key; older caches only have the display name in statusCategory. */
  statusCategoryKey?: "new" | "indeterminate" | "done";
  /** Values of analysis.yaml's extra fields (settings.fields), by field id. */
  extra?: Record<string, string | null>;
  /** Jira's Flagged field (analysis.yaml blocked.flagField) has a value. */
  flagged?: boolean;
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
  noteColumn: string;
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
  | { type: "views" | "columns" | "links" }
  | { type: "orphans" }
  | { type: "reading" | "readingGroom"; id: string }
  | { type: "readingConfig" }
  | { type: "board" };

export interface BoardCard {
  key: string;
  row: Row | null;
  missing: boolean;
  /** Only on reading:<id> cards; null when the item's file is gone. */
  reading?: ReadingSummary | null;
}

export interface BoardResponse {
  columns: string[];
  archiveColumn: string;
  noteColumn: string;
  cards: Record<string, BoardCard[]>;
  fetchedAt: string | null;
  error: string | null;
  locked: boolean;
}

export type ReadingSource = "confluence" | "slack" | "video" | "web";

export interface ReadingConfig {
  statuses: string[];
  doneStatus: string;
  categories: string[];
  prompts: string[];
  groomPrompt: string;
}

export interface ReadingSummary {
  id: string;
  title: string;
  status: string;
  url: string;
  source: ReadingSource;
}

export interface ReadingItem extends ReadingSummary {
  category: string | null;
  tickets: string[];
  created: string;
  /** The file's mtime, ISO: edits made in Obsidian count. */
  updated: string;
  mtimeMs: number;
  note: string;
  groom: { summary: string; groomedAt: string } | null;
  parseError: string | null;
}

export interface ReadingListResponse {
  items: ReadingItem[];
  config: ReadingConfig;
  error: string | null;
}
