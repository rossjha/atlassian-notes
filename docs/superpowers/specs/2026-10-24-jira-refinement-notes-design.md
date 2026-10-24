# atlassian-notes — Jira refinement notes (design)

Date: 2026-10-24
Status: approved

## Intent

A small local web app for refining Jira tickets privately. It pulls tickets from Jira (read-only) into configurable table views and lets the user keep their own notes — plus notes written by Claude Code's grooming skill — alongside each ticket. Notes are plain markdown files on the user's disk.

**Why:** the user (an engineering manager) refines current sprint, next sprint and backlog, drilling into tickets one by one. They need somewhere to grok the work, record questions, and track follow-ups that the team should not see. They have no Jira admin rights and won't get a personal-annotation plugin. The current alternative — a Google Sheet fed by a Jira connector — imports data fine but is a poor place to think: a note plus a link in a cell. This app replaces that sheet.

**Also:** the user will zip it up and share it on their work Slack, so it must be lean, generic, and contain no personal data or secrets.

## Goals

- Tabs of saved **views**; each view = a JQL query + a chosen, ordered set of columns.
- An editable **My note** column per ticket, persisted as markdown on disk.
- A read-only **Claude (groom)** column showing output written by the user's `groom-work-item` Claude Code skill.
- User-defined **custom columns** (e.g. Category) — free text or a coloured dropdown — stored per ticket, filterable and sortable locally.
- A **drill-in** panel per ticket: Jira details, full note (editable), full groom output, and buttons: copy ticket, copy notes, copy both (for Claude), copy groom prompt, open in Jira.
- Notes **survive anything** short of deleting the folder: no browser storage involved.
- Shareable as a zip: clone/unzip, set `.env`, `npm install`, `npm start`.

## Non-goals (v1)

- Writing anything back to Jira. The app only ever makes read (GET-style) requests.
- Confluence support. The user may later add a Confluence reading list and page notes — see "Future-proofing" — but nothing is built for it now.
- A Jira-page overlay, browser extension or userscript (explored and dropped).
- A UI for defining custom columns — those are defined in a config file by hand.
- Multi-user, sync, auth, hosting. It's a single-user localhost tool.
- An aggregated "all my follow-ups" view (nice idea, not requested; later).

## Anti-goals (would make it a failure even if it works)

- Any note content, config, cache or token ending up inside the app folder (and therefore in a shared zip).
- Any network traffic other than to the configured Jira site — no CDNs, telemetry, fonts, analytics at runtime.
- The app overwriting a groom file, or Claude/groom overwriting the user's note.
- Heavy dependency footprint or a complex build that makes colleagues give up on setup.

## Constraints

- Work laptop, macOS, Firefox. Claude Code runs on the same laptop.
- Jira Cloud (`*.atlassian.net`), personal API token (email + token, basic auth). If the org offers scoped tokens, the README should recommend a read-only scope; otherwise a classic token, and the app guarantees read-only behaviour itself.
- Server binds to `127.0.0.1` only.
- Result size: cap each view at 500 rows (configurable per view as `limit`), paginating through Jira's search until the cap. No table virtualisation needed at that size.

## Decided by the user

- **Local web app**, standalone (not built on the user's `forge` foundation), in `~/dev/atlassian-notes`.
- **Node + TypeScript**, plain UI (no SPA framework), **Tailwind**, **dark** UI.
- **`.env`** for Jira URL / email / token / notes location (lives outside the app folder — see call 15).
- **Layout A:** each tab is one JQL query rendered as a table; rows are tickets. (Not the side-by-side lanes layout.)
- Columns can be shown/hidden and reordered per view; views can be created from the UI (“+ view”).
- Notes column display toggle: **truncated single line** vs **expanded** in-table.
- Two note columns: the user's own, and one Claude fills from the `groom-work-item` skill.
- Custom columns: free text or dropdown with colours; **defined in a config file, not via UI**.
- Notes are markdown files; export/backup concern is solved by files being the store.
- Filtering is two-step: JQL, then local filters set **in the UI** on custom columns. Option lists for dropdown columns are only edited in `columns.yaml`, never in the UI.
- Note and groom files carry both the ticket key and the Jira internal id in front matter.

## Design calls made by Claude (user should sanity-check)

1. **Data lives outside the app.** `.env` sets `NOTES_DIR` (default `~/atlassian-notes-data`). Everything personal — notes, groom output, views, column definitions, cache — lives there. The app folder ships only code + `*.example` files.
2. **Folder layout** (namespaced by source so Confluence can slot in later):
   ```
   $NOTES_DIR/
     views.yaml            # tabs: name, jql, columns (ordered, with visibility + display mode)
     columns.yaml          # custom column definitions + Jira field mapping
     jira/
       notes/PAY-412.md    # user's note (front matter holds custom column values)
       groom/PAY-412.md    # written by Claude Code; app reads only
     .cache/               # last Jira results, so the app opens instantly / offline
   ```
3. **User note format:** markdown with YAML front matter for custom-column values:
   ```markdown
   ---
   key: PAY-412
   jira_id: "10234"
   category: Payments re-platform
   ---
   Unclear who owns the idempotency key.
   - [ ] ask Sam re: gateway limits
   ```
   The table's "My note" column shows the body (truncated or expanded); front matter feeds custom columns. Picking a dropdown value in the UI rewrites only that front-matter key, preserving the body.
4. **Groom file format (the contract with the skill):**
   ```markdown
   ---
   key: PAY-412                 # optional when written by the skill; the app fills it in
   jira_id: "10234"             # optional; the app fills it in
   readiness: Needs work        # free text; short
   summary: 3 gaps in AC; suggest split into retry + alerting
   groomed_at: 2026-10-22T14:03:00Z
   ---
   (full groom output, any markdown)
   ```
   Column shows `readiness` + `summary` + age. If the file lacks front matter, show the first non-empty line. The README documents this so anyone can adapt their own skill; the user adds one instruction to `groom-work-item`: "save output to `$NOTES_DIR/jira/groom/<KEY>.md` in this format".
5. **"Changed since" flags:** compare Jira `updated` against the note file's mtime and the groom file's `groomed_at` (fallback mtime). Show a small marker when Jira is newer.
6. **Live reload from disk:** the server watches `$NOTES_DIR` and pushes changes to the browser (Server-Sent Events), so when Claude writes a groom file or the user edits a note in their editor, the table updates without refresh.
7. **Views persist to `views.yaml`.** UI actions (+ view, edit JQL, show/hide, reorder, display toggle) write back to the file; hand edits to the file are picked up live. Ship a `views.example.yaml` with current sprint / next sprint / backlog examples.
8. **Custom columns + Jira field mapping in `columns.yaml`:**
   ```yaml
   jiraFields:
     storyPoints: customfield_10016   # differs per Jira site
   custom:
     category:
       label: Category
       type: select
       options:
         Payments re-platform: "#5b8def"
         Tech debt: "#e5b45b"
         Quick win: "#4caf7d"
     ownerGuess:
       label: Owner guess
       type: text
   ```
   Available Jira columns v1: key, summary, status, type, priority, assignee, reporter, story points (mapped), epic/parent, labels, sprint, updated. Builder may add others cheaply.
9. **Two-step filtering:** step 1 is the view's JQL (what Jira returns); step 2 is local filters on custom columns that narrow what's rendered. **Local filters are set in the UI** — e.g. a filter bar or column-header control offering the options defined in `columns.yaml` (multi-select "one of", plus empty / not-empty; free-text columns get a contains match). What the UI can't do is create/edit/delete the *option lists* — those stay in `columns.yaml` (user's decision). Active filters are saved with the view in `views.yaml` (Claude's call, consistent with call 7), shown as removable chips, with a "clear filters" action and a visible "showing N of M" count. Click-to-sort on any column (not persisted).
10. **Refresh:** manual refresh button per view + background refresh every `REFRESH_MINUTES` (default 15). Show "last refreshed" time. Serve cached results immediately on open.
11. **Tailwind compiled at build time** (Tailwind CLI), output CSS served locally. No runtime CDN. Strict CSP (`default-src 'self'`).
12. **Copy formats:**
    - *Copy ticket:* markdown — key, summary, URL, status, type, points, description, acceptance criteria if present, comments (author/date/body).
    - *Copy notes:* the user's note body.
    - *Copy both for Claude:* ticket + user note + existing groom output, under headings.
    - *Copy groom prompt:* a short templated prompt (template in `columns.yaml` or `.env`, default e.g. "Run groom-work-item on PAY-412 and save to …") — shown for ungroomed tickets and in drill-in.
13. **Jira API:** Jira Cloud REST v3 enhanced search (`/rest/api/3/search/jql`, token-based pagination), requesting only needed fields; issue detail + comments fetched on drill-in. Descriptions and comments arrive as Atlassian Document Format — convert to markdown (headings, lists, code, links, mentions as plain names; unsupported nodes degrade to text).
14. **Editing UX:** inline note editing in the table (click → textarea, save on blur / Cmd+Enter) and in the drill-in. If the file changed on disk since it was loaded, warn rather than silently overwrite.

15. **Config location (resolves token-in-zip risk):** the app reads its env file from `~/.config/atlassian-notes/.env` (overridable via `ATLASSIAN_NOTES_ENV` env var). It never reads `./.env` in the app folder, so zipping a working copy can't leak the token. `npm run setup` copies `.env.example` there and prompts for site URL, email, token, default project key and `NOTES_DIR`. `npm run pack` produces a clean zip (excludes `node_modules`, build output, any stray `.env`) — README tells people to share that.
16. **Example views work on any Jira:** setup asks for a default project key. On first run, if `$NOTES_DIR/views.yaml` is missing, it is created from `views.example.yaml` with that key substituted (one-time copy, no runtime templating):
    - Current sprint: `project = KEY AND sprint in openSprints() ORDER BY rank`
    - Next sprint: `project = KEY AND sprint in futureSprints() ORDER BY rank` (all future sprints — users can narrow it)
    - Backlog: `project = KEY AND sprint is EMPTY AND statusCategory != Done ORDER BY rank`
17. **Notes follow renamed tickets (lightweight):** when the app creates a note or reads a groom file, it records both `key` (e.g. `PAY-412`, human/Claude-readable) and `jira_id` (Jira's numeric issue id, stable across moves) in front matter — user's request, so the file is self-describing to anyone reading it. Both are kept current on refresh; on a key change the app updates `key` along with renaming the files. On refresh, if a ticket's key has no note but a note file carries its `jira_id`, the app renames the note/groom files to the new key. Notes whose ticket can't be found are never deleted; the app shows an "orphaned notes" count linking to a simple list. The groom contract treats `jira_id` as optional.

## Future-proofing (not built)

Namespacing by source (`jira/…`) and keeping the "source → items → notes" shape generic leaves room for a `confluence/` source later (reading list of pages + per-page notes). Don't abstract for it now; just don't hardcode paths that would block it.

## Left to the builder

- Server shape (plain `node:http` vs a tiny router like Hono), front-end structure, how TS is compiled/run (e.g. `tsx` for dev, `tsc` for build), test approach.
- Choice of small libraries (YAML, front matter, markdown rendering, ADF conversion) — keep the count low and avoid anything that phones home.
- Exact visual design within "dark, dense, table-first" — see the mockup direction: compact rows, monospace keys, subtle pills for status, dashed boxes for notes, a distinct tint for Claude's column.
- Error states: bad token, invalid JQL (show Jira's error message in the view), missing `NOTES_DIR` (create it with example config on first run).

## Done looks like

- From a fresh unzip: set `.env`, `npm install`, `npm start`, browser opens to the app showing the example views against the user's Jira.
- User adds a note to a ticket in the table; `jira/notes/KEY.md` appears; edits in a text editor show up in the app live.
- Claude Code writes `jira/groom/KEY.md`; the Claude column updates live with readiness/summary.
- A Category dropdown defined in `columns.yaml` appears with colours, and a view filtered on it shows only matching tickets.
- Zipping the app folder contains no notes, cache, token or personal config.
- Network inspector shows requests only to `localhost` and the configured Jira site.
