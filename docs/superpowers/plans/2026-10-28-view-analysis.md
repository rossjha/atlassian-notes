# View Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tickets | Analysis toggle on every view tab, with charts configured per view in an optional `analysis.yaml`, and click-through from a chart to the matching tickets.

**Architecture:** All analysis maths is pure and lives in `src/shared/analysis.ts` (config parsing, membership rules, aggregations, sprint position, drill-down). The server loads `analysis.yaml`, serves it with `/api/config`, and adds sprint dates, link target status, the status category key and configured extra fields to the Jira fetch. The browser draws charts as plain SVG/HTML in `src/web/analysis.ts`.

**Tech Stack:** TypeScript (Node ≥22.18 runs .ts), `node --test`, vanilla DOM via `h()`, Tailwind v4 CSS with theme tokens, `yaml`.

**Spec:** `docs/superpowers/specs/2026-10-28-view-analysis-design.md`

## Global Constraints

- No new runtime dependencies; no chart library.
- Charts use `var(--chart-1…5)`, `var(--success)` for done, `var(--chart-2)` for in progress, `var(--dim)` for to do; square cards; mono type.
- No real Jira component names, option names or field ids in code, tests, docs or examples (`customfield_00000`-style placeholders, made-up components).
- Analysis is computed in the browser from the view's rows **before** filter chips; never calls Jira.
- Motion through `motionAllowed()` / `motionMs()`; plays once per show, never on live refresh.
- Unknowns never drop out: Other, (none), Unassigned, "+N unestimated".

## Review Focus

1. Tickets in several groups: every % is a share of the view's real total; drill-down for a group returns exactly the chart's members.
2. Cached tickets written before this change (no `statusCategoryKey`, no sprint dates, no link status) must not crash analysis: fall back to the category name; no countdown; links count as not done.
3. Broken `analysis.yaml`: red bar, defaults for every view, last good extra fields kept for the fetch.
4. Weekend / before-start / after-end dates in the sprint countdown.
5. The drill-down chip and counts stay consistent after a live refresh changes rows.

---

### Task 1: Analysis maths (`src/shared/analysis.ts`)

**Files:** Create `src/shared/analysis.ts`, `test/analysis.test.ts`. Modify `src/shared/types.ts` (Ticket additions below, so the maths can read them).

**Interfaces — Produces:**
- `Ticket` gains optional `statusCategoryKey?: "new" | "indeterminate" | "done"`, `extra?: Record<string, string | null>`, `flagged?: boolean`; `TicketSprint` gains `startDate?: string; endDate?: string`; `TicketLink` gains `done?: boolean`.
- `type Category = "done" | "inProgress" | "todo"`; `categoryOf(t: Ticket): Category` (key first, else name: Done→done, To Do→todo, else inProgress).
- `interface AnalysisSettings { measure: "points" | "tickets"; movingDays: number; stalledDays: number; lowLoad: number; freeze: { week: number; day: number } | null; blocked: { statuses: string[]; flagField: string | null; links: boolean }; fields: string[] }`, `DEFAULT_SETTINGS`.
- `type ByKey = string` (validated: `assignee|status|type|priority|component|label|group:<set>|column:<id>|field:<id>`).
- `interface ChartSpec { type: ChartType; by?: ByKey; title?: string; measure?: "points" | "tickets" }`, `ChartType = "countdown" | "headlines" | "progress" | "bars" | "donut" | "statusBars" | "complete" | "completeBy" | "perPerson" | "attention"`.
- `interface AnalysisConfig { settings: AnalysisSettings; groups: Record<string, Record<string, string[]>>; views: Record<string, { settings: AnalysisSettings; charts: ChartSpec[] }> }`.
- `parseAnalysisConfig(raw: unknown): AnalysisConfig` — throws `Error` with a readable message; `null`/missing → empty config with defaults. Per-view `settings` merged over global (fields and flagField global only: per-view values ignored).
- `chartsFor(cfg: AnalysisConfig | null, viewId: string, hasSprint: boolean): { settings: AnalysisSettings; charts: ChartSpec[] }` — defaults when the view is absent: `[countdown?, headlines, progress, perPerson, attention, {type:"bars", by:"component"}]`.
- `componentMatches(pattern: string, component: string): boolean` (`*` wildcard, case-insensitive).
- `valuesOf(row: Row, by: ByKey, cfg: AnalysisConfig): string[]` — never empty: `["(none)"]`/`["Unassigned"]`/`["Other"]`.
- `measureOf(row, measure): number`.
- `blockedReasons(row: Row, s: AnalysisSettings): string[]` (`"status Blocked"`, `"flagged"`, `"blocked by PAY-1"`); empty when done.
- `isStalled(row, s, now: Date)`, `isMoving(row, s, now)`, `idleDays(row, now)`.
- `split(rows, by, cfg, measure): { total: number; tickets: number; unestimated: number; overlap: number; items: { value: string; measure: number; tickets: number; done: number; inProgress: number; todo: number; share: number }[] }` sorted by measure desc, Other/(none)/Unassigned last.
- `complete(rows): { byPoints: number; byTickets: number; donePoints: number; totalPoints: number; doneTickets: number; totalTickets: number; unestimated: number }`.
- `perPerson(rows, s): { name: string; open: number; unestimated: number; low: boolean }[]` (Unassigned last, never low).
- `attention(rows, s, now): { row: Row; why: string; blocked: boolean; idle: number }[]` (blocked first, then stalled; each oldest `updated` first).
- `sprintOf(rows): { name: string; start: Date; end: Date } | null` (active sprint with dates that most rows are in).
- `sprintPosition(sp, freeze, today: Date): { week: number; day: number; days: { date: Date; today: boolean; freeze: boolean; past: boolean }[]; daysLeft: number; toFreeze: number | null; freezePassed: boolean; ended: boolean; notStarted: boolean }`.
- `type Drill = { kind: "value"; by: ByKey; value: string; label: string } | { kind: "blocked" | "stalled" | "moving" | "done" | "unassigned"; label: string }`; `drillRows(rows, d, cfg, s, now): Row[]`.

- [ ] Write `test/analysis.test.ts` covering: categoryOf fallback; parse errors (unknown chart type, `by` missing for bars, bad freeze `W3/D9`, non-list group) and per-view merge; componentMatches wildcard/case; valuesOf for group overlap/Other/(none)/Unassigned/column/field; split shares of real total with overlap count; complete with unestimated; perPerson low rules (threshold, unestimated never low, Unassigned last); blockedReasons (status, flag, open link, done link ignored, done ticket never blocked); stalled vs moving vs blocked; attention ordering; sprintOf majority; sprintPosition W/D on weekday, weekend shows Friday, daysLeft, toFreeze 0 on freeze day and freezePassed after, notStarted/ended; drillRows equals chart membership for value and each kind.
- [ ] Run `node --test test/analysis.test.ts` → FAIL (module missing).
- [ ] Implement.
- [ ] Run → PASS; commit `feat(analysis): pure analysis maths and config parsing`.

### Task 2: Server — config, fetch fields, API

**Files:** Modify `src/server/configFiles.ts` (`loadAnalysis(notesDir): Promise<AnalysisConfig | null>` wrapping parse errors in `ConfigFileError("analysis.yaml", …)`), `src/server/watcher.ts` (`analysis.yaml` → `{ type: "analysis" }`), `src/shared/types.ts` (LiveEvent `analysis`), `src/server/app.ts` (`/api/config` adds `analysis: AnalysisConfig | null` and `analysisError: string | null`), `src/server/jira.ts`, `src/server/main.ts`, `src/web/api.ts` (ConfigResponse fields), `examples/analysis.example.yaml` (made-up names). Tests: `test/configFiles.test.ts`, `test/app.test.ts`, `test/jira.test.ts`, watcher test if present.

**Jira:** `Opts` gains `extraFields?: () => string[]` and `flagField?: () => string | null`; `fieldList` appends them; `mapTicket` sets `statusCategoryKey` from `status.statusCategory.key`, sprint `startDate`/`endDate` (ISO via `toIso`), link `done` from `inwardIssue/outwardIssue.fields.status.statusCategory.key === "done"`, `flagged` when the flag field is non-empty, `extra[id]` = option `value` ?? `name` ?? string ?? joined array ?? null.
**main.ts:** `let analysisFetch = { fields: [] as string[], flagField: null as string | null }`; `reloadAnalysisFetch()` on start and on the `analysis` watcher event updates it only when `loadAnalysis` succeeds (last good kept). Pass getters to both client constructions.

- [ ] Tests first: loadAnalysis missing → null, broken → ConfigFileError naming analysis.yaml; `/api/config` returns analysis + analysisError (broken file → analysis null, error set, views still served); jira mapTicket new fields (extend a fixture with statusCategory key, sprint dates, a blocking link with status, a flag field and an option field) and that `fields` param includes extra/flag ids; watcher maps analysis.yaml.
- [ ] Run → FAIL. Implement. Run → PASS. Commit `feat(analysis): analysis.yaml, extra Jira fields, sprint dates and link status`.

### Task 3: Web — toggle, charts, click-through

**Files:** Create `src/web/analysis.ts` (`renderAnalysis(el, input: { rows: Row[]; viewId: string; cfg: AnalysisConfig | null; columns: ColumnsConfig; now: Date; animate: boolean }, handlers: { onDrill(d: Drill): void; onOpenTicket(key: string): void }): void`). Modify `src/web/main.ts` (mode per view in localStorage `atlassian-notes.viewMode.<id>`; toggle as first child of the view header; drill state `drill: { viewId; d: Drill } | null`, shown as a chip in the filter bar and applied before `applyFilters`; ⌘K command "Toggle Analysis"), `src/web/filterBar.ts` (optional drill chip with ×, count text "Showing N of M" stays truthful), `src/web/styles.css` (`an-*` classes per the mock, phone stacks to one column), `src/web/icons.ts` if a chart icon is needed.

- Each chart type renders as in the mock; hover title shows value and share; clickable elements are `<button>`s (keyboard reachable) calling `onDrill`; attention rows call `onOpenTicket`.
- Motion: bars/rings animate from 0 via CSS transition triggered next frame when `animate` is true (first render after switching to Analysis or changing view; false on live refresh).
- Broken config → `analysisError` joins the red bar, defaults used.

- [ ] Manual verification in the browser (test server on a notes copy on port 4319): both modes, every chart type via a temporary analysis.yaml, click-through for a bar, donut segment, headline and person, chip × clears, reduced-motion, phone width, two themes, no console errors.
- [ ] typecheck + full suite + build green. Commit `feat(analysis): Tickets | Analysis toggle, charts and click-through`.

### Task 4: Docs

- [ ] README "Analysis" section (toggle, file format with made-up example, chart table, click-through, defaults) and data tree line; commit `docs: analysis`.
