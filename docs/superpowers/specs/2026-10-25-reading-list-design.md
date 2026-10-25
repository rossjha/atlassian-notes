# Reading list: design

Date: 2026-10-25. Status: draft for review.

## Intent

A reading list inside atlassian-notes, next to the Jira work it belongs to. Most items are Confluence pages, but they also include work videos, articles people share, and Slack threads. The user will be in this tab a lot, and the list will grow. ★ turns an item into an action on the user's existing Kanban board, so the board becomes the place to work through reading. Each item carries the user's own note: usually a literature note (their reflection, in their own words, on what they understood), sometimes just a rough question or a todo. Items link to Jira tickets (often epics), so reading shows up from the ticket's side as well.

The user said they might otherwise track reading on an Obsidian Kanban. The point of building it here is that this is the app they live in and the reading relates to the tickets.

## Goals

- Adding a link takes one step: paste a URL, press Enter, and it's on the list.
- Every item has a title, URL, status, category, linked tickets, ★, created and updated times, and the user's note.
- A Pending / Open questions / Complete workflow, shown as sub-tabs.
- ★ puts the item on the Kanban board as a card, alongside ticket cards.
- A ticket's side panel lists the reading linked to it.
- Claude can write a summary for an item, as with ticket grooming, through a copy-prompt and a file contract.
- Items are plain markdown files that Obsidian can open and include in its graph.

## Non-goals (for now)

- Fetching anything from the linked page (title, content or preview). The app only ever contacts Jira, and that doesn't change. Titles are guessed from the URL and the user can edit them.
- Relating reading items to each other. The user is "not too fussed here just yet". Links to tickets are enough for v1.
- Tags beyond a single category.
- Per-view column configuration for the reading table, which Jira views have.

## Anti-goals (would make it a failure even if it works)

- Adding a link takes more than paste + Enter, for example a form that must be filled in first.
- Any network request other than the existing Jira calls, including favicon or preview fetches.
- Losing a note: an item's note must never be silently overwritten or deleted.
- The reading list cluttering the Kanban for tickets. Only ★ items go on the board.
- Icons that don't match the app's outline style.

## Constraints (from the project)

- **Local and private.** Everything lives in `NOTES_DIR`, and configuration is in files rather than CRUD screens, consistent with `views.yaml`, `columns.yaml`, `board.yaml` and `links.yaml`. Hand edits are picked up live by the watcher.
- **Writes go through `atomicWrite`** (temp files under `.cache/tmp`; see the fix on `feat/docker`, which may or may not be merged when this is built).
- **Generic names only** in examples, tests, docs and commits. Never use the user's real Jira or Confluence space names, option names or people. Examples use `acme`, `PAY` and similar.
- **Icons:** Heroicons 24px outline, 1.5 stroke, no fill, inlined as path data in `src/web/icons.ts`. Heroicons has no glasses, so the 👓 icon is a custom outline path drawn to the same grid and stroke (two round lenses, a bridge, short arms).
- Vanilla TS front end built from `h()`, the same table, side panel and menu components and CSS tokens; all themes must work.
- Node's test runner. Logic that can be pure lives in `src/shared/` or a pure server module and is unit-tested.

## What the user decided

1. **Placement:** a new tab with a glasses icon, **third** in the tab bar, after Kanban and Scratchpad and before the divider and the Jira views.
2. **Adding:** a URL bar at the top of the tab, styled like the JQL bar. Paste + Enter adds the item as Pending. There is **no modal**: details are filled in later in the side panel. The user handed this decision to Claude, and it was shown in the mockup without objection.
3. **Fields:** title, URL, status, category, linked tickets, ★, created and updated.
4. **Statuses:** **Pending** (default), **Open questions** (read, but left something to chase) and **Complete**. These replace the earlier "read" and "raw thought" ideas. Each status is a **sub-tab** in the reading tab, plus **All**.
5. **Categories** are user-defined options, like the custom select columns in `columns.yaml`.
6. **★ = on my Kanban.** Starring an item puts it on the existing Kanban board as a card, the same as starring a ticket. Unstarring removes it. The user wants the board to be their action list for reading.
7. **Ticket links:** an item links to zero or more ticket keys. The ticket's side panel shows "Reading" with the linked items.
8. **Note per item:** the user's own literature note, question or todo. Reading prompts sit at the top of the note area (why we read, prompts, a Zettelkasten-style framing).
9. **Copy menu and Claude:** like the ticket panel's Copy menu, including a prompt for Claude. Claude writes a groom-style file for the item that the app reads and shows, the same as `jira/groom/<KEY>.md` for tickets.
10. **Outline icons** throughout, matching the theme.

## Claude's calls (the user can overrule any of these)

- **Storage:** one markdown file per item at `NOTES_DIR/reading/items/<id>.md`. Front matter holds the fields and the body is the user's note. Claude's output goes to `NOTES_DIR/reading/groom/<id>.md`. Obsidian sees both.
- **Item id:** `<created date>-<slug of the initial title>`, e.g. `2026-10-25-retry-strategy-for-card-captures`, with `-2` and so on added on collision. It is lowercase `[a-z0-9-]`, at most 80 characters, and never changes when the title is edited.
- **Front matter:**
  ```yaml
  ---
  id: 2026-10-25-retry-strategy-for-card-captures
  url: https://acme.atlassian.net/wiki/spaces/PAY/pages/123/Retry+strategy+for+card+captures
  title: Retry strategy for card captures
  status: Pending
  category: Architecture        # or omitted
  tickets: [PAY-40, PAY-412]
  links: ["[[jira/tickets/PAY-40|PAY-40]]", "[[jira/tickets/PAY-412|PAY-412]]"]
  source: confluence            # confluence | slack | video | web
  created: 2026-10-25T10:02:00Z
  ---
  (the user's note, markdown)
  ```
  The plain `tickets` list is what the app reads. `links` is written alongside it only so Obsidian's graph draws edges. This follows the convention in `2026-10-24-obsidian-graph-and-plan-design.md`. If only `tickets` is edited by hand, the app regenerates `links` on its next write.
- **Updated** is the file's mtime, so edits made in Obsidian count. **Created** comes from front matter, falling back to the file's birthtime or mtime. There is no separate "Note updated" column: the note and the fields share one file, so its mtime can't tell them apart, and adding a separate timestamp would ignore edits made in Obsidian.
- **Title guess from the URL:**
  - Confluence: the page-title segment of `/wiki/spaces/<SPACE>/pages/<id>/<Title+Slug>`, URL-decoded with `+` turned into spaces.
  - Slack: "Slack thread".
  - Known video hosts: "Video: <last path segment>".
  - Anything else: host plus the last meaningful path segment.

  `source` is derived from the URL in the same way. A URL is Confluence when its host matches the Jira site's host and its path starts with `/wiki/`, or when the host ends in `.atlassian.net` and the path starts with `/wiki/`. This is a pure function with table-driven tests.
- **Same URL twice:** if the URL (normalised by trimming whitespace and dropping a trailing slash) is already on the list, nothing new is added. The app opens the existing item's side panel and shows a short "Already on your list" toast.
- **Invalid input:** only `http:` and `https:` URLs are accepted. Anything else gets an inline hint under the bar, like the ticket search's "Enter a key like ABC-123".
- **`reading.yaml`** in `NOTES_DIR` holds the configuration. It is created from `examples/reading.example.yaml` on first run, like the other config files:
  ```yaml
  statuses: [Pending, Open questions, Complete]   # first = default for new items; each is a sub-tab
  doneStatus: Complete                            # used by Kanban archive (below)
  categories: [Architecture, RFC, Discussion, Learning]
  prompts:                                        # shown above the note editor
    - Why am I reading this?
    - What is it saying, in my own words?
    - How does it connect to the work, and to what I already know?
    - What do I question or disagree with?
    - What will I do next?
  groomPrompt: "Read {url} ({title}). Write a reading summary to {groomPath} with front matter summary and groomed_at (ISO): key ideas, how it relates to {tickets}, open questions. My notes so far are in {notePath}."
  ```
  A broken `reading.yaml` behaves like a broken `views.yaml`: the error bar explains it, the list is still shown, and editing the affected fields is locked. An item whose status isn't in `statuses` (renamed in the file, say) still appears under All and keeps its value until changed.
- **Prompts are shown, not written into the file.** They appear as a muted list above the note editor, so notes stay clean, and changing the prompts later doesn't leave stale copies in old notes. This matches the mockup.
- **Kanban:**
  - Board cards stay string ids. Reading cards use `reading:<id>` in `board.yaml`. The parser accepts these as well as ticket keys; previously it warned about and dropped anything that wasn't a valid key.
  - A reading card shows the glasses icon, the title and a status pill, and clicking it opens the reading side panel.
  - A reading card whose file has gone shows as missing, like a ticket card whose ticket is missing.
  - The board's existing "archive" action (clearing `archiveColumn`) sets a reading item's status to `doneStatus` if it isn't already, then removes the card as usual.
  - `noteColumn` auto-move rules apply only to tickets.
  - Apart from archive, status and the board don't affect each other. Setting Complete in the side panel leaves the card where it is, dragging a card into `archiveColumn` doesn't change status, and re-opening a Complete item doesn't add it back to the board. The user moves cards themselves; archive is the one tidy-up that also marks items done.
  - `reading:` ids are left out of the board's Jira refresh. `parseBoard` must not upper-case them (ticket keys are upper-cased; reading ids are lower-case).
- **Ticket key renames:** when the app detects that a ticket's key changed (the existing reconcile step), it rewrites `tickets:` and `links:` in reading items that point to the old key. Only those two front-matter fields change; the body is never touched. A file that changed since it was read, or that can't be parsed, is skipped and logged, never forced.
- **Ticket side panel:** a "Reading" section listing linked items (glasses icon, title and status), each opening the reading side panel. It is hidden when there are none. Ticket hub files `jira/tickets/<KEY>.md` gain a "Reading" list of wikilinks to the linked items, so the graph connects both ways.
- **Reading table columns:** ★, Title (link-style; clicking opens the side panel, and an ↗ icon opens the URL in a new tab), Status, Category, Tickets, Groomed, Updated and Added. Sortable like the Jira tables. Filters are Category and Ticket, in the same filter-bar style; status is covered by the sub-tabs. Default sort is Added, newest first. The active sub-tab is remembered in localStorage.
- **Reading side panel:** reuses the ticket side panel's shell and its Esc and close behaviour.
  - Header: ★, the title (editable inline), ↗ open, and a Copy menu.
  - Fields: Status (select), Category (select), Tickets (chips with remove, plus "+ add" taking a key, validated with the same key rule), Source and URL (editable).
  - Then the prompts, the note editor (the same editor and save and conflict behaviour as ticket notes), and Claude's groom output when present.
  - A ⋯ menu offers "Delete…" with a confirm dialog. Delete moves the item and its groom file to `NOTES_DIR/.cache/trash/reading/`, so the files are never destroyed, and removes any board card.
- **Copy menu:**
  - "Link": `[title](url)`.
  - "My note": the note body.
  - "Item + note for Claude": title, URL, tickets, status, the note and any groom output, as markdown.
  - "Prompt for Claude": `groomPrompt`, with `{url}`, `{title}`, `{tickets}`, `{groomPath}` and `{notePath}` filled in.
- **Groom file contract** (README gets a section next to the ticket one): Claude writes `reading/groom/<id>.md` with optional front matter `summary` and `groomed_at`. Without `summary`, the first non-empty line is used. The app never edits the body.
- **⌘K palette:**
  - Go to: "Reading" (current when active).
  - Under the Reading heading: "Add a link…" focuses the URL bar, and one item per status sub-tab switches to it.
  - Typing a URL into the palette offers "Add <url> to reading list", the counterpart of "Open PAY-412".
- **Live updates:** the watcher maps
  - `reading/items/<id>.md` to `{ type: "reading", id }`
  - `reading/groom/<id>.md` to `{ type: "readingGroom", id }`
  - `reading.yaml` to `{ type: "readingConfig" }`

  The client reloads what's affected, in the same way it handles notes and groom files now.
- **Rendering of note and groom HTML** uses the same server-side sanitised markdown as tickets (`renderMarkdownSafe`), and is shown via `setHtml`.

## Left to the builder

- How to reuse versus fork `table.ts`, `drawer.ts`, `filterBar.ts` and `board.ts`. The reading row isn't a Jira `Row`, so a small adapter or a parallel module is fine. Prefer reuse where it keeps behaviour identical, such as sorting, resizing affordances, the panel shell and the note editor.
- API shape, following the existing `/api/...` style. Suggested routes:
  - `GET /api/reading` (items and config)
  - `POST /api/reading` (add a URL)
  - `PUT /api/reading/<id>` (field changes)
  - `PUT /api/reading/<id>/note` (body with `baseMtimeMs` conflict check)
  - `DELETE /api/reading/<id>`
  - `GET /api/reading/<id>/copy/<kind>`

  The mutation routes keep the same Origin and content-type checks.
- The exact glasses path, provided it reads clearly at the tab-icon size and matches the stroke weight.
- Whether the board response embeds reading summaries in `BoardCard` (e.g. a `reading` field next to `row`) or the client joins them.
- Splitting this into more than one plan, if that helps. A natural split: (1) the list, side panel, files and config; (2) Kanban and ticket links; (3) Claude copy and groom, the palette and hub-file links.

## Testing

- Unit tests:
  - URL to title/source guessing
  - id slugging and collisions
  - front matter round-trip, including regenerating `links` from `tickets`
  - `reading.yaml` parsing and errors
  - watcher path mapping
  - board parsing with `reading:` ids
  - archive setting `doneStatus`
  - the duplicate-URL rule
  - delete moving files to the trash folder
- Manual check in the browser:
  - add by paste + Enter
  - sub-tabs
  - star to Kanban and back
  - ticket panel listing
  - copy prompt
  - a groom file written by hand appearing live
  - an edit in Obsidian appearing live
