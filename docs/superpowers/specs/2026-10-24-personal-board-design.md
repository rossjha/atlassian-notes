# atlassian-notes: personal board (phase 2a), design

Date: 2026-10-24
Status: draft for approval
Builds on: `docs/superpowers/specs/2026-10-24-jira-refinement-notes-design.md` (phase 1, shipped). Everything there still applies: privacy, GET-only Jira, localhost only, data outside the app folder, config in files.

## Intent

A personal kanban board for tickets the user wants to come back to. Tickets get noticed in many places:
- someone mentions one in stand-up and the user looks it up, perhaps through a personal search view
- the user browses a ticket and wants to learn more
- the user needs to talk to someone about it
- the user's own refinement sessions turn it up

The user knows they won't deal with it straight away, and these tickets build up. Today they slip away. The board lets the user curate them, work through them at their own pace, and keep notes on each. Because everything is plain files, the board is also something the user can hand to Claude.

## Goals

- A **"★ My board" tab** next to the JQL view tabs.
- **Columns defined in YAML**, e.g. Backlog, Doing, PEN, Done.
- **Adding tickets:** click the ★ in any table view to put a ticket on the board. Click it again to take the ticket off.
- **Kanban basics:**
  - drag cards between columns
  - drag cards up and down to set their order within a column
  - order is saved
- **Archive:** an "Archive all" button on the Done column removes those cards from the board. This is the same as un-starring them. Notes are kept.
- **Cards** show the key, the title, the Jira status, Claude's readiness (when groomed) and the user's note.
- **Click the note on a card** to edit it inline (the same editor as the table).
- **Click the title** to open the existing side panel (drill-in drawer).
- Board state is a plain file that Claude can read.

## Non-goals (phase 2a)

- Obsidian/graph features. That is phase 2b, a separate design.
- Writing anything to Jira. A card's Jira status is display only, and moving a card never changes Jira.
- WIP limits, swimlanes, card colours, due dates, multiple boards.
- A UI for adding, renaming or reordering columns. Columns are edited in `board.yaml`.
- An "archived" history view.
- A dedicated "copy board for Claude" action. The files are readable as-is, and the README explains how.

## Anti-goals

- Losing a card's note, or its place on the board, because a ticket was renamed, moved project, or disappeared from every JQL view.
- One bad or deleted ticket breaking the whole board.
- Any of the phase 1 anti-goals: data inside the app folder, non-Jira network traffic, overwriting a file that couldn't be parsed.

## Decided by the user

- A personal kanban with YAML-defined columns (e.g. Backlog, Doing, PEN, Done).
- Drag to move cards between columns and to order them.
- Archive the Done column. This only removes the board membership.
- Notes are editable directly on the card. Clicking the card title opens the side panel, like the table.
- The mockup was approved: a board tab, cards with key, title, status pill, readiness and note, and ★ in table views to add tickets.

## Design calls made by Claude (check these)

1. **One file, `$NOTES_DIR/board.yaml`, holds both the columns and the card placement:**
   ```yaml
   columns: [Backlog, Doing, PEN, Done]   # order = left to right; hand-edit to change
   archiveColumn: Done                    # gets the "Archive all" button; defaults to the last column
   cards:                                 # written by the app; order within a list = order on the board
     Backlog: [SCRUM-41, SCRUM-52]
     Doing: [SCRUM-33]
     PEN: [SCRUM-29]
     Done: []
   ```
   - `ensureDataDir` creates it from `examples/board.example.yaml` on first run, and never overwrites an existing file.
   - A key appears at most once across all columns. If a hand edit duplicates one, the first occurrence in column order wins.
   - Cards under a column name that isn't in `columns` (for example after a hand-renamed column) appear in the **first** column, and no card is ever dropped.
   - This normalisation happens in memory only. The file is not rewritten until the next change made through the app, so a hand edit is never clobbered on read.
   - If the file can't be parsed, the board shows the error and all board-changing controls are disabled. This is the same rule as `views.yaml`.

   **Why one file and not front matter on each note:**
   - Ordering needs a single list.
   - A drag writes once.
   - Starring a ticket doesn't create a note file.

   For phase 2b (Obsidian), the board can be mirrored into front matter later if useful.
2. **The ★ column is a fixed, narrow first column in every table view.** Star state comes from `board.yaml` alone, with no Jira call: the client holds the set of board keys from `GET /api/board` and updates it on `board` live events. The shared `Row` type is unchanged. While `board.yaml` can't be parsed, the stars are shown disabled. It is not part of the configurable column list, so it appears in existing `views.yaml` files without edits.
   - A filled ★ means the ticket is on the board, in any column.
   - Starring appends the ticket to the bottom of the first column.
   - Un-starring removes it from whichever column it's in.
3. **Board ticket data** comes from Jira by key, independently of the JQL views.
   - The board's tickets are refreshed by searching on their keys, in chunks. The board is cached like a view, as `.cache/board.json`.
   - It is refreshed:
     - on startup
     - on the background interval
     - from a Refresh button on the board
     - after starring a ticket that isn't in any view cache
   - A key Jira can't find (deleted, or no permission) must not fail the whole board. Jira rejects a whole `key in (...)` search if one key is invalid, so the builder must handle that, for example by falling back to per-key lookups.
   - A card whose ticket can't be found shows the key with a "not found in Jira" marker, and stays until the user removes it.
   - After a key search, any requested key missing from the results gets one per-key lookup (`GET issue/{key}`). That call follows moved issues: if it returns a different key, it's a rename (see call 4). If it returns 404, the key is "not found". Not-found results are remembered for 24 hours, like phase 1's reconcile check state, so a dead key doesn't cost a call every cycle.
   - Card data comes from the board cache. For a key not yet in the board cache, such as one just starred, it comes from any view cache that has it. Otherwise the card shows the key alone until the refresh lands.
4. **Renames:** a key change is detected in two places, and either way `board.yaml` is updated to the new key in the same position:
   - phase 1's reconcile renaming a note or groom file
   - the board refresh's per-key lookup, for starred tickets that have no note file

   If a note or groom file exists under the old key, the rename also goes through `notes.renameKey`. Board-cache tickets join reconcile's `seen` set, so a board-only ticket that has left every JQL view isn't probed as unseen.
5. **Cards:**
   - Line 1 shows the key in monospace plus the title, which is a link-styled button that opens the drawer.
   - Line 2 shows the Jira status pill, plus a readiness pill when a groom file exists.
   - Below that is the note in a dashed box, clamped to 3 lines, with "+ add note" when there is none. Clicking it opens the inline note editor (`editNote`), which grows to fit.
   - On hover there is a small ✕ to take a single card off the board, with no confirmation, because notes are kept.
   - The "Jira changed since your note" orange dot from the table also appears on cards.
6. **Drag and drop** uses native HTML5 drag events. A drop marker shows where the card will land. The new position is saved through one `move` operation. Updates are optimistic, and the board reverts with an error message if the save fails.
   - Keyboard alternative (my call, kept small): a focused card can be moved with Alt+←/→ (column) and Alt+↑/↓ (order).
7. **Live updates:** `board.yaml` changes made outside the app (hand edits, or Claude) are picked up live through the existing watcher and SSE, as a new `board` live event. Note and groom events update the cards too.
8. **Archive all:** removes every card in `archiveColumn` from `board.yaml`. It asks for confirmation inside the button ("Archive 4 cards?" → confirm), never with `window.confirm`.
9. **API** (same security rules as phase 1):
   - `GET /api/board` → `{ columns, archiveColumn, cards: Record<column, Row[]>, missing: string[], fetchedAt, error }`, where `Row` is the same shape the table uses.
   - `POST /api/board/ops` → body is one **operation**, not the whole map, so concurrent hand edits or Claude edits aren't overwritten. The server applies it to the file as it currently is on disk:
     - `{op:"add", key}` appends to the first column; no-op if already present.
     - `{op:"remove", key}`.
     - `{op:"move", key, column, index}` inserts at `index` in `column`, clamped.
     - `{op:"archive"}` removes every key in `archiveColumn`.

     It validates keys with `isValidKey` and column names against `columns`, and refuses with 409 if `board.yaml` can't currently be parsed. It returns the new board, which uses the same shape as `GET`.
   - `POST /api/board/refresh`.
10. **Claude:** the README gains a short section explaining that `board.yaml` plus `jira/notes/<KEY>.md` describe the board. It includes an example ask, "read my board.yaml and the notes for everything in Doing, then …".

## Left to the builder

- Module boundaries (e.g. `src/server/board.ts`, `src/web/board.ts`), and how the board view coexists with the table in `main.ts`.
- The chunk size for key searches and the exact fallback for invalid keys.
- Visual details within the existing dark, dense style and the approved mockup.
- Test approach. Server logic (board file validation, rename handling, missing keys, PUT validation) must have tests. The UI is verified by build plus a smoke run, as in phase 1 (ruling R4), then the user's browser check.

## Done looks like

- ★ a ticket in a table view and it appears at the bottom of Backlog on "★ My board".
- Drag it to Doing, and reorder it within Doing. Reload, and the order is kept. `board.yaml` shows it.
- Click the card's note and type. `jira/notes/<KEY>.md` is updated. Click the title and the drawer opens.
- Move two cards to Done, then Archive all. They leave the board, their ★ in table views is cleared, and their notes are still there.
- Hand-edit `board.yaml` to add a column or move a key. The board updates live.
- A starred ticket that is later deleted in Jira shows as "not found", and the rest of the board still loads.
- A ticket that moves project keeps its place on the board under its new key.
