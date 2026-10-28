# View analysis: design

Date: 2026-10-28 · Branch: `feat/view-analysis` · Approved mock: [2026-10-28-view-analysis-mock.html](2026-10-28-view-analysis-mock.html)

## Intent

Every view tab gets an **Analysis** side next to its ticket table: charts and headline numbers worked out from the tickets that view already fetched. Ross uses views for two jobs, and the analysis serves both.

- **Current sprint (stand-up, mid-sprint check):** what's moving, what's stalled or blocked, who's light on work, and where we are in the sprint ("W1/D4, 4 working days to freeze, 6 left").
- **Refinement of an epic (bigger picture):** % complete, the frontend/backend split, and how the work spreads across components and products.

Ross defines what each view shows in a file, because the useful splits depend on how his team uses Jira. Products and frontend/backend aren't Jira fields: they are **groups of components** (a product is, say, `lambda API` + `x UI` + `infra`; frontend is the `… UI` components). The file is optional: a view without an entry still gets a sensible default analysis.

## Goals

1. A **Tickets | Analysis** toggle at the left of each view's header (only on view tabs, not Kanban, Scratchpad or Reading). It's remembered per view in the browser. Default: Tickets.
2. An optional `analysis.yaml` in the notes folder, read live like `views.yaml`, with:
   - **settings** (thresholds, measure, freeze point, blocked rules, extra Jira fields), each overridable per view;
   - **groups**: named component groupings shared by all views;
   - **views**: per view id, the ordered list of charts.
3. Chart types (see "Charts" below): sprint countdown, headline numbers, status progress, bar list, donut, stacked bar by status, % complete ring, % complete per group, and the needs-attention list.
4. Blocked and stalled detection, sprint position and freeze countdown, from data the app fetches (with two small additions to the Jira fetch: sprint dates and, if configured, the flag field and extra custom fields).
5. A default chart set for views not in the file.
6. Charts look like the mock: the theme's `--chart-1…5` colours (so all 10 themes work), status colours for done / in progress / to do, mono type, square cards, no library chrome.
7. Gentle entrance motion like forge's charts (bars grow, rings fill, numbers count up, ~700ms ease-out, once per show), off when the OS asks for reduced motion — using the app's existing `motion.ts` helpers.

## Non-goals

- **Trends over time** (no snapshots or history). Ross explicitly dropped this.
- Editing analysis config in the UI; the file is the editor.
- Exporting or sharing charts.
- Charts on the Kanban, Scratchpad or Reading tabs.
- Days-in-current-status (needs the Jira changelog); "stalled" uses the ticket's `updated` time.
- Public holidays in working-day maths.

## Anti-goals (a failure even if it works)

- Charts that call Jira themselves or slow the table: analysis is computed in the browser from the view's rows.
- A broken `analysis.yaml` breaking the table, other tabs, or the analysis of views it doesn't concern. It shows as the usual red error bar and the Analysis side falls back to the default set.
- Tickets silently dropping out of a split. Anything not in a group shows as **Other**; anything with no value shows as **(none)** / **Unassigned**; unestimated tickets are counted and said ("4 unestimated").
- Library-default look (grey grids, rounded tooltips, shadows), or a new chart dependency. Charts are plain SVG/HTML, drawn by the app.
- Motion that loops, bounces, replays on every live refresh, or runs with reduced motion on.
- Real Jira option names, component names or field ids in commits, tests, docs or examples (use made-up ones).

## How it works (decided)

### Data

- Input is the view's current rows (`Row[]`: ticket + note + custom column values), **before** the table's filter chips: analysis describes the view's query, not the chips. *(My call; Ross didn't specify.)*
- The keyword search (`search`) does apply, because it changes what the view fetched.
- Done / in progress / to do come from Jira's status category (`done`, `indeterminate`, `new`).
- **Measure:** `points` (default) or `tickets`, per setting. With points, unestimated tickets count 0 and the chart notes how many there are.
- Extra Jira fetch:
  - **Sprint dates:** the sprint objects already fetched carry `startDate` / `endDate`; keep them on `TicketSprint`.
  - **Flag:** if `settings.blocked.flagField` names a field id, fetch it; a ticket is flagged when it has a value.
  - **Extra fields:** `settings.fields: [customfield_…]` adds fields to the fetch, so charts can group by them (`by: field:customfield_…`, using the option's value/name, or the text).
  - Adding fields means views refresh with them on the next refresh; until then those charts show "(none)".

### Groups

```yaml
groups:
  product:
    Payments: [lambda API, payments UI, infra]
    Notifications: [notify-api, "notify-*"]
  layer:
    Frontend: ["* UI"]
    Backend: [lambda API, notify-api]
```

- A group set (`product`, `layer`) maps names to component patterns. `*` matches any run of characters; matching ignores case.
- A ticket belongs to every group any of its components matches (so it can count twice; charts using groups say "a ticket can be in more than one").
- **Shares with overlap** *(my call)*: every % is a share of the **view's real total** (so with overlap they can add up to more than 100%, and the chart says how many tickets are in more than one group). A donut's slices are drawn in proportion to each other, but its centre shows the view's real total, not the sum of slices. Other is always shown and always included.
- No match → **Other**.

### Settings (defaults in brackets)

```yaml
settings:
  measure: points          # [points] | tickets
  movingDays: 2            # [2] updated within this many days counts as moving
  stalledDays: 3           # [3] in progress and not updated for more than this
  lowLoad: 3               # [3] open measure per person below this is "low"
  freeze: W2/D3            # [none] release freeze, as a working day of the sprint
  blocked:
    statuses: [Blocked]    # [[]] status names that mean blocked
    flagField: customfield_00000   # [none] Jira's Flagged field
    links: true            # [true] an "is blocked by" link to a ticket not done
  fields: []               # [[]] extra Jira field ids to fetch
views:
  current:
    settings: { lowLoad: 5 }   # overrides for this view
    charts: [...]
```

### Sprint position

- The view's sprint is the active sprint most of its tickets are in. If its tickets have no active sprint with dates, the countdown chart doesn't show (and the default set leaves it out).
- Working days are Mon–Fri. `W/D` is the working day of the sprint counted from its start date: day 1–5 is W1, 6–10 is W2. On a weekend, today shows as the last working day (Friday) *(my call)*.
- "Working days left" counts from tomorrow to the end date inclusive; "to freeze" counts working days until the freeze day (0 = today is freeze day; past freeze shows "freeze passed").
- Times use the browser's local date.

### Blocked, stalled, moving

- **Blocked** if the ticket isn't done *(my call)* and any enabled rule matches: status in `blocked.statuses`; flagged; an inward "is blocked by" link to a ticket whose status category isn't done. Link targets outside the view are looked up in the board/app cache if known, else counted as not done.
- **Stalled:** status category in progress, not blocked, and `updated` older than `stalledDays`.
- **Moving:** in progress and updated within `movingDays`.
- **Unassigned:** no assignee, not done.

### Charts

Each entry in `charts:` is a string (type with defaults) or a mapping `{type, by?, title?, measure?}`.

| type | shows | `by` |
|---|---|---|
| `countdown` | W/D today, working-day strip with today and ❄ freeze, days to freeze, days left and end date | — |
| `headlines` | Done %, Moving, Stalled, Blocked (unassigned in its note) | — |
| `progress` | one stacked bar: done / in progress / to do | — |
| `bars` | horizontal bar list, largest first | required |
| `donut` | donut with legend and total in the middle | required |
| `statusBars` | one row per value, each a done/in progress/to do stack, with share % | required |
| `complete` | % complete ring, by points and by tickets, unestimated count | — |
| `completeBy` | % complete per value | required |
| `perPerson` | open (not done) measure per assignee, "low" flagged, Unassigned last. With points, a person's unestimated open tickets show as "+N unestimated", and someone with any unestimated open work is never flagged low *(my call)* | — |
| `attention` | table: blocked first (with why), then stalled (idle days), oldest first | — |

`by` is one of: `assignee`, `status`, `type`, `priority`, `component`, `label`, `group:<set>`, `column:<app column id>` (your own columns from `columns.yaml`), `field:<jira field id>`.

Clicking a row in `attention` opens the ticket panel. Hovering a bar or segment shows its value and share.

**Click-through (Ross: "would be good to try"):** clicking a bar, donut segment, `statusBars`/`completeBy` row, a `perPerson` name or a headline number (Stalled, Blocked, Moving, Done) switches to the Tickets side showing just those tickets. *(My calls:)* this is a temporary **drill-down**, not a saved filter: it shows as one chip above the table ("Assignee: Sam ×", "Blocked ×", "product: Payments ×"), applies on top of the view's own filter chips, isn't written to `views.yaml`, and clears with ×, by switching view, or by going back to Analysis. The drill-down uses exactly the same membership rules as the chart, so the table's count matches the number clicked (the table's filter chips may narrow it further, and the count line says so).

### Defaults (view not in the file)

`[countdown (if there's a sprint), headlines, progress, perPerson, attention, bars by component]`.

## Constraints

- Vanilla TypeScript DOM via `h()`, no framework; Node ≥22.18 runs `.ts` directly; `node --test`; Tailwind v4 CSS with the theme tokens. No new runtime dependencies.
- Analysis maths lives in `src/shared/` as pure functions with unit tests; drawing lives in `src/web/`.
- `analysis.yaml` is optional and never created by the app; `examples/analysis.example.yaml` and the README document it *(my call)*.
- Config errors follow the `views.yaml` pattern (`ConfigFileError`, red bar, live reload via the watcher and SSE). The whole file is checked as one: any error (including an unknown chart type) shows the red bar and every view falls back to defaults *(my call)*.
- The server keeps the **last good** `settings.fields` and `blocked.flagField` for the Jira fetch while the file is broken, so a typo doesn't empty field-based charts or the flag rule on the next refresh *(my call)*. Those two settings are global only, never per view.
- Status category: the app currently stores the category's display name; the builder maps or also fetches the key.
- Phone width: cards stack to one column.

## Left to the builder

- Exact card sizes and grid placement per chart type (the mock is the reference).
- Tooltip look, within the anti-goals.
- How the analysis config reaches the browser (extend `/api/config` or a new endpoint).
- Number formatting, empty states ("No tickets in this view").
