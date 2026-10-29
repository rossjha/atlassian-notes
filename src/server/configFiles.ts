import fs from "node:fs/promises";
import { parseAnalysisConfig, type AnalysisConfig } from "../shared/analysis.ts";
import path from "node:path";
import YAML from "yaml";
import { BUILTIN_COLUMNS } from "../shared/types.ts";
import type { ColumnSetting, ColumnsConfig, CustomColumnDef, FilterValue, Filters, JiraColumnDef, ReadingConfig, View } from "../shared/types.ts";
import { parseLinks, type NavLink } from "../shared/links.ts";
import { atomicWrite } from "./notesStore.ts";

export class ConfigFileError extends Error {
  file: string;
  constructor(file: string, message: string) {
    super(`${path.basename(file)}: ${message}`);
    this.name = "ConfigFileError";
    this.file = file;
  }
}

const DEFAULT_SPRINT_FIELD = "customfield_10020";
const DEFAULT_LIMIT = 500;
const DEFAULT_GROOM_PROMPT =
  "Run groom-work-item on {key} ({url}). Save the result to {groomPath} with front matter: readiness, summary, groomed_at (ISO).";
const BUILTIN_IDS = new Set<string>(BUILTIN_COLUMNS.map((c) => c.id));
const VIEW_ID = /^[a-z0-9-]+$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
}

export async function ensureDataDir(notesDir: string, projectKey: string, examplesDir: string): Promise<void> {
  for (const d of ["jira/notes", "jira/groom", ".cache/views", "reading/items", "reading/groom"]) {
    await fs.mkdir(path.join(notesDir, d), { recursive: true });
  }
  for (const name of ["views", "columns", "board", "reading"]) {
    const target = path.join(notesDir, `${name}.yaml`);
    if (await exists(target)) continue;
    const template = await fs.readFile(path.join(examplesDir, `${name}.example.yaml`), "utf8");
    await atomicWrite(target, template.replaceAll("{{PROJECT}}", projectKey));
  }
}

async function readYaml(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  try {
    return YAML.parse(text);
  } catch (e) {
    throw new ConfigFileError(file, `invalid YAML (${(e as Error).message.split("\n")[0]})`);
  }
}

function strOrNull(file: string, v: unknown, name: string): string | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ConfigFileError(file, `${name} must be a string`);
  return v;
}

/**
 * links.yaml (optional): custom top-bar links. Never throws for the file's content: a broken file or bad entries
 * become `error` (shown as a warning) while views and columns keep working.
 */
export async function loadLinks(notesDir: string): Promise<{ links: NavLink[]; error: string | null }> {
  let raw: unknown;
  try {
    raw = await readYaml(path.join(notesDir, "links.yaml"));
  } catch (e) {
    if (e instanceof ConfigFileError) return { links: [], error: e.message };
    throw e;
  }
  const { links, warnings } = parseLinks(raw);
  return { links, error: warnings.length ? warnings.map((w) => `links.yaml: ${w}`).join("\n") : null };
}

export async function loadColumns(notesDir: string): Promise<ColumnsConfig> {
  const file = path.join(notesDir, "columns.yaml");
  const raw = await readYaml(file);
  if (raw !== null && !isObj(raw)) throw new ConfigFileError(file, "top level must be a mapping");
  const root: Obj = raw ?? {};
  const jf = root.jiraFields ?? {};
  if (!isObj(jf)) throw new ConfigFileError(file, "jiraFields must be a mapping");
  const custom: Record<string, CustomColumnDef> = {};
  const rawCustom = root.custom ?? {};
  if (!isObj(rawCustom)) throw new ConfigFileError(file, "custom must be a mapping");
  for (const [id, def] of Object.entries(rawCustom)) {
    if (id === "__proto__") throw new ConfigFileError(file, `custom column id "__proto__" is not allowed`);
    if (BUILTIN_IDS.has(id)) throw new ConfigFileError(file, `custom column "${id}" clashes with a built-in column`);
    if (!isObj(def) || typeof def.label !== "string") throw new ConfigFileError(file, `custom column "${id}" needs a label`);
    if (def.type === "text") {
      custom[id] = { label: def.label, type: "text" };
    } else if (def.type === "select") {
      if (!isObj(def.options)) throw new ConfigFileError(file, `custom column "${id}" needs options`);
      const options: Record<string, string> = {};
      for (const [k, c] of Object.entries(def.options)) options[k] = String(c);
      custom[id] = { label: def.label, type: "select", options };
    } else {
      throw new ConfigFileError(file, `custom column "${id}" has type "${String(def.type)}"; use select or text`);
    }
  }
  const jiraColumns: Record<string, JiraColumnDef> = {};
  const rawJira = root.jiraColumns ?? {};
  if (!isObj(rawJira)) throw new ConfigFileError(file, "jiraColumns must be a mapping");
  for (const [id, def] of Object.entries(rawJira)) {
    if (id === "__proto__") throw new ConfigFileError(file, `Jira column id "__proto__" is not allowed`);
    if (BUILTIN_IDS.has(id)) throw new ConfigFileError(file, `Jira column "${id}" clashes with a built-in column`);
    if (Object.hasOwn(custom, id)) throw new ConfigFileError(file, `Jira column "${id}" clashes with the custom column of the same id`);
    if (!isObj(def) || typeof def.label !== "string") throw new ConfigFileError(file, `Jira column "${id}" needs a label`);
    if (typeof def.field !== "string" || def.field.trim() === "") throw new ConfigFileError(file, `Jira column "${id}" needs a field (the Jira field id, e.g. customfield_10123)`);
    jiraColumns[id] = { label: def.label, field: def.field.trim() };
  }
  return {
    jiraFields: {
      storyPoints: strOrNull(file, jf.storyPoints, "jiraFields.storyPoints") ?? null,
      sprint: strOrNull(file, jf.sprint, "jiraFields.sprint") ?? DEFAULT_SPRINT_FIELD,
      acceptanceCriteria: strOrNull(file, jf.acceptanceCriteria, "jiraFields.acceptanceCriteria") ?? null,
    },
    custom,
    jiraColumns,
    groomPrompt: strOrNull(file, root.groomPrompt, "groomPrompt") ?? DEFAULT_GROOM_PROMPT,
  };
}

function parseFilter(file: string, col: string, v: unknown): FilterValue {
  if (!isObj(v)) throw new ConfigFileError(file, `filter "${col}" must be a mapping`);
  switch (v.op) {
    case "empty":
    case "notEmpty":
      return { op: v.op };
    case "oneOf":
      if (!Array.isArray(v.values)) throw new ConfigFileError(file, `filter "${col}" needs values`);
      return { op: "oneOf", values: v.values.map(String) };
    case "contains":
      if (typeof v.text !== "string") throw new ConfigFileError(file, `filter "${col}" needs text`);
      return { op: "contains", text: v.text };
    default:
      throw new ConfigFileError(file, `filter "${col}" has unknown op "${String(v.op)}"`);
  }
}

const MIN_WIDTH = 24;
const MAX_WIDTH = 4000;

/** A column width in whole px, or null when it is not a number in [MIN_WIDTH, MAX_WIDTH]. */
function parseWidth(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const w = Math.round(v);
  return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : null;
}

export async function loadViews(notesDir: string, columns: ColumnsConfig): Promise<View[]> {
  const file = path.join(notesDir, "views.yaml");
  const raw = await readYaml(file);
  if (raw === null) return [];
  return validateViews(raw, columns, file);
}

export function validateViews(
  raw: unknown,
  columns: ColumnsConfig,
  file: string = "views.yaml",
): View[] {
  if (!isObj(raw) || !Array.isArray(raw.views)) throw new ConfigFileError(file, "expected a top-level `views:` list");
  const seen = new Set<string>();
  return raw.views.map((rv, i): View => {
    if (!isObj(rv)) throw new ConfigFileError(file, `view #${i + 1} must be a mapping`);
    const { id, name, jql } = rv;
    if (typeof id !== "string" || !VIEW_ID.test(id)) {
      throw new ConfigFileError(file, `view #${i + 1} id must match [a-z0-9-]+`);
    }
    if (seen.has(id)) throw new ConfigFileError(file, `duplicate view id "${id}"`);
    seen.add(id);
    if (typeof name !== "string" || typeof jql !== "string") {
      throw new ConfigFileError(file, `view "${id}" needs name and jql`);
    }
    const limit = rv.limit ?? DEFAULT_LIMIT;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      throw new ConfigFileError(file, `view "${id}" limit must be a positive integer`);
    }
    const cols: ColumnSetting[] = [];
    for (const rc of Array.isArray(rv.columns) ? rv.columns : []) {
      const c: Obj = typeof rc === "string" ? { id: rc } : isObj(rc) ? rc : {};
      if (typeof c.id !== "string") throw new ConfigFileError(file, `view "${id}" has a column without an id`);
      if (!BUILTIN_IDS.has(c.id) && !Object.hasOwn(columns.custom, c.id) && !Object.hasOwn(columns.jiraColumns, c.id)) {
        console.warn(`${file}: view "${id}" ignores unknown column "${c.id}"`);
        continue;
      }
      const s: ColumnSetting = { id: c.id };
      if (c.hidden === true) s.hidden = true;
      if (c.display === "truncate" || c.display === "expand") s.display = c.display;
      if (c.width !== undefined && c.width !== null) {
        const w = parseWidth(c.width);
        if (w === null) console.warn(`${file}: view "${id}" column "${c.id}" ignores invalid width ${JSON.stringify(c.width) ?? String(c.width)}`);
        else s.width = w;
      }
      cols.push(s);
    }
    const filters: Filters = {};
    const rawFilters = rv.filters ?? {};
    if (!isObj(rawFilters)) throw new ConfigFileError(file, `view "${id}" filters must be a mapping`);
    for (const [col, fv] of Object.entries(rawFilters)) {
      // A filter left behind by a renamed or removed custom column is dropped, like an unknown column above.
      if (!Object.hasOwn(columns.custom, col) && !Object.hasOwn(columns.jiraColumns, col)) {
        console.warn(`${file}: view "${id}" ignores filter on unknown column "${col}"`);
        continue;
      }
      filters[col] = parseFilter(file, col, fv);
    }
    const view: View = { id, name, jql, limit, columns: cols, filters };
    if (typeof rv.search === "string" && rv.search.trim() !== "") view.search = rv.search.trim();
    return view;
  });
}

export async function saveViews(notesDir: string, views: View[]): Promise<void> {
  await atomicWrite(path.join(notesDir, "views.yaml"), YAML.stringify({ views }));
}

/** analysis.yaml (optional; null when missing). Any problem is a ConfigFileError naming the file. */
export async function loadAnalysis(notesDir: string): Promise<AnalysisConfig | null> {
  const file = path.join(notesDir, "analysis.yaml");
  const raw = await readYaml(file);
  if (raw === null) return null;
  try {
    return parseAnalysisConfig(raw);
  } catch (e) {
    throw new ConfigFileError(file, (e as Error).message);
  }
}

/** Used when reading.yaml is missing (it matches examples/reading.example.yaml) and when it is broken. */
export const DEFAULT_READING_CONFIG: ReadingConfig = {
  statuses: ["Pending", "Open questions", "Complete"],
  doneStatus: "Complete",
  categories: ["Architecture", "RFC", "Discussion", "Learning"],
  prompts: [
    "Why am I reading this?",
    "What is it saying, in my own words?",
    "How does it connect to the work, and to what I already know?",
    "What do I question or disagree with?",
    "What will I do next?",
  ],
  groomPrompt:
    "Read {url} ({title}). Write a reading summary to {groomPath} with front matter summary and groomed_at (ISO): key ideas, how it relates to {tickets}, open questions. My notes so far are in {notePath}.",
};

function stringList(file: string, v: unknown, name: string, nonEmpty: boolean): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "")) {
    throw new ConfigFileError(file, `${name} must be a list of non-empty strings`);
  }
  const list = (v as string[]).map((x) => x.trim());
  if (nonEmpty && list.length === 0) throw new ConfigFileError(file, `${name} must not be empty`);
  if (new Set(list).size !== list.length) throw new ConfigFileError(file, `${name} has duplicates`);
  return list;
}

/** reading.yaml: statuses (first = default, each a sub-tab), doneStatus, categories, prompts, groomPrompt. */
export async function loadReadingConfig(notesDir: string): Promise<ReadingConfig> {
  const file = path.join(notesDir, "reading.yaml");
  const raw = await readYaml(file);
  if (raw === null || raw === undefined) return { ...DEFAULT_READING_CONFIG };
  if (!isObj(raw)) throw new ConfigFileError(file, "top level must be a mapping");
  const statuses = raw.statuses === undefined ? DEFAULT_READING_CONFIG.statuses : stringList(file, raw.statuses, "statuses", true);
  const doneStatus = strOrNull(file, raw.doneStatus, "doneStatus") ?? statuses[statuses.length - 1];
  if (!statuses.includes(doneStatus)) throw new ConfigFileError(file, `doneStatus "${doneStatus}" is not one of the statuses`);
  return {
    statuses,
    doneStatus,
    categories: raw.categories === undefined || raw.categories === null ? [] : stringList(file, raw.categories, "categories", false),
    prompts: raw.prompts === undefined || raw.prompts === null ? [] : stringList(file, raw.prompts, "prompts", false),
    groomPrompt: strOrNull(file, raw.groomPrompt, "groomPrompt") ?? DEFAULT_READING_CONFIG.groomPrompt,
  };
}
