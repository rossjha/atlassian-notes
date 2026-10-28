// View analysis: analysis.yaml parsing and the maths behind every chart. Pure, so the browser
// computes charts from a view's rows and the tests pin the rules (see docs/superpowers/specs/2026-10-28-view-analysis-design.md).
import type { Row, Ticket } from "./types.ts";

export type Category = "done" | "inProgress" | "todo";
export type Measure = "points" | "tickets";

export const CHART_TYPES = ["countdown", "headlines", "progress", "bars", "donut", "statusBars", "complete", "completeBy", "perPerson", "attention"] as const;
export type ChartType = (typeof CHART_TYPES)[number];
/** Chart types that split the tickets by something, so need `by`. */
const NEEDS_BY: ReadonlySet<ChartType> = new Set(["bars", "donut", "statusBars", "completeBy"]);

/** assignee | status | type | priority | component | label | group:<set> | column:<app column id> | field:<jira field id> */
export type ByKey = string;

export interface ChartSpec {
  type: ChartType;
  by?: ByKey;
  title?: string;
  measure?: Measure;
}

export interface AnalysisSettings {
  measure: Measure;
  movingDays: number;
  stalledDays: number;
  lowLoad: number;
  freeze: { week: number; day: number } | null;
  blocked: { statuses: string[]; flagField: string | null; links: boolean };
  fields: string[];
}

export const DEFAULT_SETTINGS: AnalysisSettings = {
  measure: "points",
  movingDays: 2,
  stalledDays: 3,
  lowLoad: 3,
  freeze: null,
  blocked: { statuses: [], flagField: null, links: true },
  fields: [],
};

export interface AnalysisConfig {
  settings: AnalysisSettings;
  /** Group set → group name → component patterns. */
  groups: Record<string, Record<string, string[]>>;
  views: Record<string, { settings: AnalysisSettings; charts: ChartSpec[] }>;
}

export type Drill =
  | { kind: "value"; by: ByKey; value: string; label: string }
  /** A person's open (not done) tickets, as the per-person chart counts them; "Unassigned" for none. */
  | { kind: "person"; value: string; label: string }
  | { kind: "blocked" | "stalled" | "moving" | "done" | "unassigned"; label: string };

export const OTHER = "Other";
export const NONE = "(none)";
export const UNASSIGNED = "Unassigned";

const DAY_MS = 86_400_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- parsing ----------

function num(v: unknown, name: string, min: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new Error(`${name} must be a number of at least ${min}`);
  return v;
}

function strList(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${name} must be a list of strings`);
  return v as string[];
}

function parseFreeze(v: unknown): { week: number; day: number } | null {
  if (v === null || v === undefined) return null;
  const m = typeof v === "string" ? /^W([1-9]\d*)\/D([1-5])$/i.exec(v.trim()) : null;
  if (!m) throw new Error(`settings freeze must look like W2/D3 (week, then working day 1–5), not ${JSON.stringify(v)}`);
  return { week: Number(m[1]), day: Number(m[2]) };
}

/** Settings from `raw` over `base`. `global` false ignores fields and blocked.flagField (they drive the shared Jira fetch). */
function parseSettings(raw: unknown, base: AnalysisSettings, where: string, global: boolean): AnalysisSettings {
  if (raw === undefined || raw === null) return base;
  if (!isObj(raw)) throw new Error(`${where} must be a mapping`);
  const s: AnalysisSettings = { ...base, blocked: { ...base.blocked } };
  if (raw.measure !== undefined) {
    if (raw.measure !== "points" && raw.measure !== "tickets") throw new Error(`${where} measure must be points or tickets`);
    s.measure = raw.measure;
  }
  if (raw.movingDays !== undefined) s.movingDays = num(raw.movingDays, `${where} movingDays`, 0);
  if (raw.stalledDays !== undefined) s.stalledDays = num(raw.stalledDays, `${where} stalledDays`, 0);
  if (raw.lowLoad !== undefined) s.lowLoad = num(raw.lowLoad, `${where} lowLoad`, 0);
  if (raw.freeze !== undefined) s.freeze = parseFreeze(raw.freeze);
  if (raw.blocked !== undefined) {
    if (!isObj(raw.blocked)) throw new Error(`${where} blocked must be a mapping`);
    const b = raw.blocked;
    if (b.statuses !== undefined) s.blocked.statuses = strList(b.statuses, `${where} blocked.statuses`);
    if (b.links !== undefined) {
      if (typeof b.links !== "boolean") throw new Error(`${where} blocked.links must be true or false`);
      s.blocked.links = b.links;
    }
    if (global && b.flagField !== undefined) {
      if (b.flagField !== null && typeof b.flagField !== "string") throw new Error(`${where} blocked.flagField must be a field id`);
      s.blocked.flagField = b.flagField;
    }
  }
  if (global && raw.fields !== undefined) s.fields = strList(raw.fields, `${where} fields`);
  return s;
}

function checkBy(by: unknown, groups: AnalysisConfig["groups"], where: string): ByKey {
  if (typeof by !== "string") throw new Error(`${where} \`by\` must be a string`);
  if (["assignee", "status", "type", "priority", "component", "label"].includes(by)) return by;
  const m = /^(group|column|field):(.+)$/.exec(by);
  if (!m) throw new Error(`${where} \`by\` must be assignee, status, type, priority, component, label, group:<set>, column:<id> or field:<id>, not "${by}"`);
  if (m[1] === "group" && !Object.hasOwn(groups, m[2]!)) throw new Error(`${where} uses unknown group set "${m[2]}"`);
  return by;
}

function parseChart(raw: unknown, groups: AnalysisConfig["groups"], where: string): ChartSpec {
  const r: Obj = typeof raw === "string" ? { type: raw } : isObj(raw) ? raw : {};
  if (typeof r.type !== "string") throw new Error(`${where} needs a type`);
  if (!(CHART_TYPES as readonly string[]).includes(r.type)) throw new Error(`${where} has unknown chart type "${r.type}"`);
  const c: ChartSpec = { type: r.type as ChartType };
  if (NEEDS_BY.has(c.type) && r.by === undefined) throw new Error(`${where} (${c.type}) needs \`by\``);
  if (r.by !== undefined) c.by = checkBy(r.by, groups, where);
  if (r.title !== undefined) {
    if (typeof r.title !== "string") throw new Error(`${where} title must be text`);
    c.title = r.title;
  }
  if (r.measure !== undefined) {
    if (r.measure !== "points" && r.measure !== "tickets") throw new Error(`${where} measure must be points or tickets`);
    c.measure = r.measure;
  }
  return c;
}

/** analysis.yaml's parsed content (null when the file is missing). Throws a readable Error on anything invalid. */
export function parseAnalysisConfig(raw: unknown): AnalysisConfig {
  if (raw === null || raw === undefined) return { settings: DEFAULT_SETTINGS, groups: {}, views: {} };
  if (!isObj(raw)) throw new Error("expected a mapping with settings, groups and views");
  const settings = parseSettings(raw.settings, DEFAULT_SETTINGS, "settings", true);
  const groups: AnalysisConfig["groups"] = {};
  if (raw.groups !== undefined && raw.groups !== null) {
    if (!isObj(raw.groups)) throw new Error("groups must be a mapping of group sets");
    for (const [set, members] of Object.entries(raw.groups)) {
      if (!isObj(members)) throw new Error(`groups.${set} must map group names to component lists`);
      groups[set] = {};
      for (const [name, pats] of Object.entries(members)) {
        if (!Array.isArray(pats) || !pats.every((p) => typeof p === "string")) throw new Error(`groups.${set}.${name} must be a list of component names`);
        groups[set]![name] = pats as string[];
      }
    }
  }
  const views: AnalysisConfig["views"] = {};
  if (raw.views !== undefined && raw.views !== null) {
    if (!isObj(raw.views)) throw new Error("views must be a mapping of view ids");
    for (const [id, v] of Object.entries(raw.views)) {
      if (!isObj(v)) throw new Error(`views.${id} must be a mapping`);
      const vs = parseSettings(v.settings, settings, `views.${id}.settings`, false);
      const charts = v.charts === undefined ? defaultCharts(true) : Array.isArray(v.charts)
        ? v.charts.map((c, i) => parseChart(c, groups, `views.${id} chart #${i + 1}`))
        : (() => { throw new Error(`views.${id}.charts must be a list`); })();
      views[id] = { settings: vs, charts };
    }
  }
  return { settings, groups, views };
}

function defaultCharts(hasSprint: boolean): ChartSpec[] {
  return [
    ...(hasSprint ? [{ type: "countdown" as const }] : []),
    { type: "headlines" }, { type: "progress" }, { type: "perPerson" }, { type: "attention" }, { type: "bars", by: "component" },
  ];
}

/** The settings and charts for a view: its analysis.yaml entry, else the default set. */
export function chartsFor(cfg: AnalysisConfig | null, viewId: string, hasSprint: boolean): { settings: AnalysisSettings; charts: ChartSpec[] } {
  const v = cfg && Object.hasOwn(cfg.views, viewId) ? cfg.views[viewId]! : null;
  if (!v) return { settings: cfg?.settings ?? DEFAULT_SETTINGS, charts: defaultCharts(hasSprint) };
  // The countdown only shows when the view's tickets share an active sprint with dates.
  return hasSprint ? v : { settings: v.settings, charts: v.charts.filter((c) => c.type !== "countdown") };
}

// ---------- membership ----------

export function categoryOf(t: Ticket): Category {
  if (t.statusCategoryKey === "done") return "done";
  if (t.statusCategoryKey === "new") return "todo";
  if (t.statusCategoryKey === "indeterminate") return "inProgress";
  const n = t.statusCategory.toLowerCase();
  if (n === "done") return "done";
  if (n === "to do" || n === "new") return "todo";
  return "inProgress";
}

export function componentMatches(pattern: string, component: string): boolean {
  const re = new RegExp(`^${pattern.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(component.trim());
}

/** The value(s) a row has for `by`; never empty, so nothing drops out of a chart. */
export function valuesOf(row: Row, by: ByKey, cfg: AnalysisConfig): string[] {
  const t = row.ticket;
  const orNone = (vs: (string | null | undefined)[]): string[] => {
    const out = vs.filter((v): v is string => typeof v === "string" && v.trim() !== "");
    return out.length ? [...new Set(out)] : [NONE];
  };
  switch (by) {
    case "assignee": return [t.assignee || UNASSIGNED];
    case "status": return orNone([t.status]);
    case "type": return orNone([t.type]);
    case "priority": return orNone([t.priority]);
    case "component": return orNone(t.components ?? []);
    case "label": return orNone(t.labels);
  }
  const [kind, id] = [by.slice(0, by.indexOf(":")), by.slice(by.indexOf(":") + 1)];
  if (kind === "column") return orNone([row.custom[id]]);
  if (kind === "field") return orNone([t.extra?.[id]]);
  const set = cfg.groups[id] ?? {};
  const comps = t.components ?? [];
  const hits = Object.entries(set).filter(([, pats]) => comps.some((c) => pats.some((p) => componentMatches(p, c)))).map(([name]) => name);
  return hits.length ? hits : [OTHER];
}

export function measureOf(row: Row, measure: Measure): number {
  return measure === "tickets" ? 1 : row.ticket.storyPoints ?? 0;
}

const unestimated = (row: Row): boolean => row.ticket.storyPoints === null;

export function blockedReasons(row: Row, s: AnalysisSettings): string[] {
  const t = row.ticket;
  if (categoryOf(t) === "done") return [];
  const out: string[] = [];
  if (s.blocked.statuses.some((st) => st.toLowerCase() === t.status.toLowerCase())) out.push(`status ${t.status}`);
  if (s.blocked.flagField && t.flagged) out.push("flagged");
  if (s.blocked.links) {
    for (const l of t.links ?? []) {
      if (l.direction === "inward" && l.type.toLowerCase() === "is blocked by" && l.done !== true) out.push(`blocked by ${l.key}`);
    }
  }
  return out;
}

export function idleDays(row: Row, now: Date): number {
  const u = Date.parse(row.ticket.updated);
  return Number.isNaN(u) ? 0 : Math.max(0, Math.floor((now.getTime() - u) / DAY_MS));
}

const isBlocked = (row: Row, s: AnalysisSettings): boolean => blockedReasons(row, s).length > 0;

/** In progress, not blocked, and not updated for more than stalledDays. */
export function isStalled(row: Row, s: AnalysisSettings, now: Date): boolean {
  return categoryOf(row.ticket) === "inProgress" && !isBlocked(row, s) && idleDays(row, now) > s.stalledDays;
}

/** In progress, not blocked, and updated within movingDays. */
export function isMoving(row: Row, s: AnalysisSettings, now: Date): boolean {
  return categoryOf(row.ticket) === "inProgress" && !isBlocked(row, s) && idleDays(row, now) <= s.movingDays;
}

// ---------- aggregation ----------

export interface SplitItem { value: string; measure: number; tickets: number; done: number; inProgress: number; todo: number; share: number }
export interface Split { total: number; tickets: number; unestimated: number; overlap: number; items: SplitItem[] }

const LAST = new Set([OTHER, NONE, UNASSIGNED]);

export function split(rows: Row[], by: ByKey, cfg: AnalysisConfig, measure: Measure): Split {
  const items = new Map<string, SplitItem>();
  let total = 0, unest = 0, overlap = 0;
  for (const row of rows) {
    const m = measureOf(row, measure);
    total += m;
    if (measure === "points" && unestimated(row)) unest++;
    const vs = valuesOf(row, by, cfg);
    if (vs.length > 1) overlap++;
    const cat = categoryOf(row.ticket);
    for (const v of vs) {
      const it = items.get(v) ?? { value: v, measure: 0, tickets: 0, done: 0, inProgress: 0, todo: 0, share: 0 };
      it.measure += m;
      it.tickets++;
      it[cat] += m;
      items.set(v, it);
    }
  }
  const list = [...items.values()];
  for (const it of list) it.share = total > 0 ? it.measure / total : 0;
  list.sort((a, b) => Number(LAST.has(a.value)) - Number(LAST.has(b.value)) || b.measure - a.measure);
  return { total, tickets: rows.length, unestimated: unest, overlap, items: list };
}

export function complete(rows: Row[]) {
  let donePoints = 0, totalPoints = 0, doneTickets = 0, unest = 0;
  for (const row of rows) {
    const d = categoryOf(row.ticket) === "done";
    const p = row.ticket.storyPoints ?? 0;
    totalPoints += p;
    if (d) { donePoints += p; doneTickets++; }
    if (unestimated(row)) unest++;
  }
  const totalTickets = rows.length;
  return {
    byPoints: totalPoints > 0 ? donePoints / totalPoints : 0,
    byTickets: totalTickets > 0 ? doneTickets / totalTickets : 0,
    donePoints, totalPoints, doneTickets, totalTickets, unestimated: unest,
  };
}

export interface PersonLoad { name: string; open: number; unestimated: number; low: boolean }

/** Open (not done) work per assignee, most first, Unassigned last. With points, anyone holding unestimated work is never "low". */
export function perPerson(rows: Row[], s: AnalysisSettings): PersonLoad[] {
  const map = new Map<string, PersonLoad>();
  for (const row of rows) {
    const name = row.ticket.assignee || UNASSIGNED;
    const p = map.get(name) ?? { name, open: 0, unestimated: 0, low: false };
    map.set(name, p);
    if (categoryOf(row.ticket) === "done") continue;
    p.open += measureOf(row, s.measure);
    if (s.measure === "points" && unestimated(row)) p.unestimated++;
  }
  const list = [...map.values()];
  for (const p of list) p.low = p.name !== UNASSIGNED && p.unestimated === 0 && p.open < s.lowLoad;
  return list.sort((a, b) => Number(a.name === UNASSIGNED) - Number(b.name === UNASSIGNED) || b.open - a.open || a.name.localeCompare(b.name));
}

export interface AttentionItem { row: Row; why: string; blocked: boolean; idle: number }

/** Blocked tickets (with why), then stalled ones; each group oldest update first. */
export function attention(rows: Row[], s: AnalysisSettings, now: Date): AttentionItem[] {
  const blocked: AttentionItem[] = [], stalled: AttentionItem[] = [];
  for (const row of rows) {
    const reasons = blockedReasons(row, s);
    const idle = idleDays(row, now);
    if (reasons.length) blocked.push({ row, why: reasons.join(", "), blocked: true, idle });
    else if (isStalled(row, s, now)) stalled.push({ row, why: `idle ${idle}d`, blocked: false, idle });
  }
  const oldest = (a: AttentionItem, b: AttentionItem) => Date.parse(a.row.ticket.updated) - Date.parse(b.row.ticket.updated);
  return [...blocked.sort(oldest), ...stalled.sort(oldest)];
}

// ---------- sprint ----------

export interface SprintRef { name: string; start: Date; end: Date }

const localDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isWeekday = (d: Date): boolean => d.getDay() !== 0 && d.getDay() !== 6;

/** The active sprint (with dates) that most of the rows are in, or null. */
export function sprintOf(rows: Row[]): SprintRef | null {
  const counts = new Map<string, { n: number; start: string; end: string }>();
  for (const row of rows) {
    for (const sp of row.ticket.sprints ?? []) {
      if (sp.state !== "active" || !sp.startDate || !sp.endDate) continue;
      const c = counts.get(sp.name) ?? { n: 0, start: sp.startDate, end: sp.endDate };
      c.n++;
      counts.set(sp.name, c);
    }
  }
  let best: [string, { n: number; start: string; end: string }] | null = null;
  for (const e of counts) if (!best || e[1].n > best[1].n) best = e;
  if (!best) return null;
  const start = new Date(best[1].start), end = new Date(best[1].end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { name: best[0], start: localDay(start), end: localDay(end) };
}

export interface SprintPosition {
  week: number;
  day: number;
  days: { date: Date; today: boolean; freeze: boolean; past: boolean }[];
  daysLeft: number;
  toFreeze: number | null;
  freezePassed: boolean;
  ended: boolean;
  notStarted: boolean;
  /** Today falls within the sprint (week/day are only meaningful then). */
  inSprint: boolean;
}

/** Where today falls in the sprint, in working days (Mon–Fri). On a weekend, today is the last working day before it. */
export function sprintPosition(sp: SprintRef, freeze: { week: number; day: number } | null, now: Date): SprintPosition {
  const workdays: Date[] = [];
  for (let d = localDay(sp.start); d <= sp.end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (isWeekday(d)) workdays.push(d);
  }
  let today = localDay(now);
  while (!isWeekday(today)) today = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const notStarted = localDay(now) < localDay(sp.start);
  const ended = localDay(now) > sp.end;
  const idx = notStarted || ended ? -1 : workdays.findIndex((d) => d.getTime() === today.getTime());
  const freezeIdx = freeze ? (freeze.week - 1) * 5 + (freeze.day - 1) : -1;
  const freezeDay = freezeIdx >= 0 && freezeIdx < workdays.length ? workdays[freezeIdx]! : null;
  const pos = idx >= 0 ? idx : notStarted ? 0 : Math.max(workdays.length - 1, 0);
  const daysLeft = workdays.filter((d) => d > localDay(now)).length;
  let toFreeze: number | null = null, freezePassed = false;
  if (freezeDay) {
    if (localDay(now) > freezeDay) freezePassed = true;
    else toFreeze = workdays.filter((d) => d > localDay(now) && d <= freezeDay).length;
  }
  return {
    week: Math.floor(pos / 5) + 1,
    day: (pos % 5) + 1,
    days: workdays.map((d, i) => ({ date: d, today: i === idx, freeze: i === freezeIdx, past: idx >= 0 ? i < idx : ended })),
    daysLeft,
    toFreeze,
    freezePassed,
    ended,
    notStarted,
    inSprint: idx >= 0,
  };
}

// ---------- drill-down ----------

/** The rows behind a clicked chart element: exactly the chart's own membership rule. */
export function drillRows(rows: Row[], d: Drill, cfg: AnalysisConfig, s: AnalysisSettings, now: Date): Row[] {
  switch (d.kind) {
    case "value": return rows.filter((r) => valuesOf(r, d.by, cfg).includes(d.value));
    case "person": return rows.filter((r) => (r.ticket.assignee || UNASSIGNED) === d.value && categoryOf(r.ticket) !== "done");
    case "blocked": return rows.filter((r) => isBlocked(r, s));
    case "stalled": return rows.filter((r) => isStalled(r, s, now));
    case "moving": return rows.filter((r) => isMoving(r, s, now));
    case "done": return rows.filter((r) => categoryOf(r.ticket) === "done");
    case "unassigned": return rows.filter((r) => !r.ticket.assignee && categoryOf(r.ticket) !== "done");
  }
}
