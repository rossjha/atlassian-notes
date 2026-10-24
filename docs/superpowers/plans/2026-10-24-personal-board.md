# Personal Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal kanban board ("★ My board") to atlassian-notes. Tickets are starred from any table view, ordered across columns defined in YAML, and their notes can be edited on the card.

**Architecture:**
- `board.yaml` under `NOTES_DIR` holds the columns and the ordered card keys.
- A pure board module validates and normalises that file and applies single operations to it. A per-process write queue serialises those operations.
- A `BoardService` fetches board tickets from Jira by key, independently of views. It handles invalid, renamed and deleted keys, and builds cards from the board cache plus the view caches.
- The UI adds a fixed ★ column to tables and a board view, using HTML5 drag and drop.

**Tech Stack:** As in phase 1: Node ≥ 22.18 running TS natively, `yaml`, `marked`, Tailwind v4, `node:test`, and plain-TS browser modules compiled by `tsc`.

**Spec:** `docs/superpowers/specs/2026-10-24-personal-board-design.md`. Read it fully. It builds on `docs/superpowers/specs/2026-10-24-jira-refinement-notes-design.md`. Spec items are cited as "call N".

## Global Constraints

- Every phase 1 constraint still applies:
  - GET-only Jira.
  - The server listens on `127.0.0.1` only, with the Host, Origin and Content-Type gates on its API.
  - CSP `default-src 'self'`. `innerHTML` only through `setHtml` for server `*Html` fields. Colours only through `style.setProperty`.
  - No personal data inside the app folder.
  - Never rewrite a file that couldn't be parsed. Atomic writes go through `atomicWrite` in `src/server/notesStore.ts`.
  - Erasable TypeScript only. Relative imports use `.ts`.
  - Custom CSS class names must not collide with Tailwind utilities. Grep `public/app.css` after building.
- No new dependencies.
- The board file is `$NOTES_DIR/board.yaml`. The example is `examples/board.example.yaml`:
  ```yaml
  columns: [Backlog, Doing, PEN, Done]
  archiveColumn: Done
  cards:
    Backlog: []
    Doing: []
    PEN: []
    Done: []
  ```
- Moving a card never touches Jira (spec non-goals).
- Not-found keys are remembered for 24 hours (call 3).
- The board tab label is exactly `★ My board`.

## Review Focus

1. **A hand-edited `board.yaml`** with a duplicated key, a key under an unknown column, or an invalid key. Normalised on read, the first occurrence wins, unknown-column cards go to the first column, and the file is not rewritten on read. Test: Task 1.
2. **Operations arriving close together** (rapid drags, a star click during a hand edit). All are applied against the current file, with none lost. Test: Task 1, 10 concurrent `add` operations all present.
3. **One deleted or forbidden key among many starred tickets.** The other cards still load, and the bad key is shown as not found. Test: Task 2.
4. **`board.yaml` broken.** `GET` reports `locked` with the error, operations return 409, the file is byte-identical, and the stars are disabled. Tests: Tasks 1 and 3.
5. **A starred ticket with no note file moves project.** It keeps its board position under the new key. Test: Task 2.

## Plan-level rulings (refining the spec)

- **`GET /api/board` cards shape.** Call 9 says cards are `Record<column, Row[]>` plus `missing`. The plan uses `Record<column, BoardCard[]>`, where `BoardCard = { key, row: Row | null, missing: boolean }`, because a just-starred or not-found key has no `Ticket` to build a `Row` from. There is no separate `missing` list.
- **Board cache location.** Call 3 says `.cache/board.json`. The plan reuses `ViewCache` with the id `_board`, so the file is `.cache/views/_board.json`. View ids match `/^[a-z0-9-]+$/`, so the two can't collide.
- **Invalid key strings in `board.yaml`** (failing `isValidKey`) are ignored with a `console.warn`. They can't be tickets. They disappear from the file at the next write made through the app.

---

## File Structure

```
examples/board.example.yaml        new: default board
src/shared/types.ts                + BoardFile, BoardOp, BoardCard, BoardResponse; LiveEvent + {type:"board"}
src/server/board.ts                new: parse/normalise/serialise, applyBoardOp, renameInBoard, load/save/updateBoard
src/server/boardService.ts         new: BoardService (refresh by key, not-found state, renames, cards)
src/server/configFiles.ts          ensureDataDir also copies board.example.yaml
src/server/watcher.ts              board.yaml → {type:"board"}
src/server/refresher.ts            optional `board` dep: refresh after views, seen += board tickets, renames → board
src/server/app.ts, main.ts         /api/board routes; wiring
src/web/api.ts                     board(), boardOp(), refreshBoard()
src/web/table.ts                   fixed ★ column
src/web/board.ts                   new: board view (lanes, cards, DnD, keyboard moves, archive)
src/web/main.ts, styles.css        board tab, star state, live events
README.md                          board + "using it with Claude"
test/board.test.ts, test/boardService.test.ts, test/app.test.ts (extend), test/refresher.test.ts (extend), test/configFiles.test.ts (extend)
```

---

### Task 1: Board file model and operations

**Files:**
- Create: `examples/board.example.yaml`, `src/server/board.ts`, `test/board.test.ts`
- Modify: `src/shared/types.ts`, `src/server/configFiles.ts` (`ensureDataDir`), `src/server/watcher.ts` (`eventForPath`), `test/configFiles.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `interface BoardFile { columns: string[]; archiveColumn: string; cards: Record<string, string[]> }`
    - after normalisation, every column has an array, even if empty
  - `type BoardOp = { op: "add"; key: string } | { op: "remove"; key: string } | { op: "move"; key: string; column: string; index: number } | { op: "archive" }`
  - `LiveEvent` gains `| { type: "board" }`
- Produces (`board.ts`):
  - `parseBoard(text: string, file: string): BoardFile`
    - throws `ConfigFileError(file, …)` on a YAML error, on `columns` missing, empty or non-string, on duplicate column names, or on `archiveColumn` not in `columns`
    - `archiveColumn` defaults to the last column
    - normalises the cards: unknown-column keys are appended to the first column, duplicates keep the first occurrence in column order, and keys failing `isValidKey` are dropped with a `console.warn`
  - `serialiseBoard(b: BoardFile): string`
    - YAML with `columns` in flow style, then `archiveColumn`, then `cards` in `columns` order
  - `boardKeys(b: BoardFile): string[]`, in column order then card order
  - `applyBoardOp(b: BoardFile, op: BoardOp): BoardFile`
    - pure; returns a new object
    - `add`: appends to the first column; a no-op if the key is anywhere on the board
    - `remove`: a no-op if the key is absent
    - `move`: removes the key from its column and inserts it at `index`, clamped to `0..length`, in `column`; a key not yet on the board is added there
    - `archive`: empties `archiveColumn`
    - throws `BoardOpError` (exported, extends `Error`) for an invalid key or an unknown column
  - `renameInBoard(b: BoardFile, oldKey: string, newKey: string): BoardFile`
    - replaces in place; if `newKey` is already present, it just removes `oldKey`
  - `loadBoard(notesDir: string): Promise<BoardFile>`, which throws `ConfigFileError` naming `board.yaml`
  - `updateBoard(notesDir: string, fn: (b: BoardFile) => BoardFile): Promise<BoardFile>`
    - reads the file fresh, applies `fn`, and saves with `atomicWrite`, but only if the result differs
    - calls are serialised through a module-level promise chain keyed by `notesDir`
    - a parse error rejects and writes nothing
- `ensureDataDir` copies `board.example.yaml` to `board.yaml` if it is missing, and never overwrites.
- `eventForPath("board.yaml")` returns `{ type: "board" }`.

- [ ] **Step 1: Write the failing tests** in `test/board.test.ts`:
  - `parseBoard` on the example gives 4 columns, `archiveColumn` `"Done"`, and each column `[]`.
  - Normalisation: `cards: {Doing: [A-1, B-2], Old: [C-3], Done: [A-1, bad key]}` with columns `[Backlog, Doing, Done]` gives Backlog `["C-3"]`, Doing `["A-1","B-2"]` and Done `[]`. Stub `console.warn` and assert it was called once.
  - Throws `ConfigFileError` with `file` ending `board.yaml` for broken YAML, for `columns: []`, and for `archiveColumn: Nope`.
  - `applyBoardOp`:
    - `add` appends to Backlog, and adding a second time is a no-op
    - `move` of `B-2` to `Done` at `0` gives Done `["B-2"]` and removes it from Doing
    - `move` with `index: 99` appends
    - `archive` empties Done
    - `move` to an unknown column throws `BoardOpError`
    - `add` with `"x"` throws `BoardOpError`
  - `renameInBoard`: `A-1` → `NEW-9` keeps the same position, and renaming onto an existing key removes the old one.
  - `updateBoard`:
    - 10 concurrent `updateBoard(dir, b => applyBoardOp(b, {op:"add", key:`K-${i}`}))` leave all 10 keys in the file
    - on a broken `board.yaml` it rejects with `ConfigFileError`, and the file is byte-identical afterwards
  - Saving then loading round-trips. A hand edit made between two `updateBoard` calls survives the second one.
- [ ] **Step 2:** Extend `test/configFiles.test.ts`: `ensureDataDir` creates `board.yaml`, and a second call keeps edits. Extend the watcher mapping test, or add an `eventForPath("board.yaml")` assertion, wherever `eventForPath` is tested.
- [ ] **Step 3: Run** `npm test`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: board.yaml model and serialised board operations`.

---

### Task 2: BoardService and refresher integration

**Files:**
- Create: `src/server/boardService.ts`, `test/boardService.test.ts`
- Modify: `src/shared/types.ts`, `src/server/refresher.ts`, `test/refresher.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 (`loadBoard`, `updateBoard`, `renameInBoard`, `applyBoardOp`, `boardKeys`)
  - `JiraClient.search(jql, limit)` and `getIssueDetail(idOrKey)`; `JiraError.status`
  - `ViewCache` and `CachedView`
  - `NotesStore` (`readNote`, `readGroom`, `renameKey`, `ensureIdentity`)
  - `buildRow(ticket, note, groom, customIds)`
- Produces (`types.ts`):
  - `interface BoardCard { key: string; row: Row | null; missing: boolean }`
  - `interface BoardResponse { columns: string[]; archiveColumn: string; cards: Record<string, BoardCard[]>; fetchedAt: string | null; error: string | null; locked: boolean }`
- Produces (`boardService.ts`):
  - `const BOARD_CACHE_ID = "_board"`
  - `class BoardService`, constructed as `new BoardService(deps: { jira: JiraClient; cache: ViewCache; notes: NotesStore; notesDir: string; statePath: string; onChange: (e: LiveEvent) => void; now?: () => Date })`
  - Methods:
    - `refresh(): Promise<void>` (see below)
    - `tickets(): Promise<Map<string, Ticket>>`: the board cache's tickets by key
    - `rename(oldKey: string, newKey: string): Promise<void>`: `updateBoard(renameInBoard)`, then emit `board` if anything changed
    - `apply(op: BoardOp): Promise<void>`
      - `updateBoard(b => applyBoardOp(b, op))`, then emit `board`
      - for `add` of a key that isn't in the board cache or any view cache, also start `refresh()` without awaiting it
    - `view(customIds: string[], viewIds: string[]): Promise<BoardResponse>`
      - on a `ConfigFileError` from `loadBoard` it returns empty columns and cards, `error` set to the message, and `locked: true`
      - otherwise each card's ticket comes from the board cache, else from `cache.allTickets(viewIds)`, else `row: null`
      - `missing` is `true` when the not-found state for that key is under 24 hours old
      - `error` is the board cache's `error`
- `refresh()` algorithm (call 3):
  1. Get `keys = boardKeys(await loadBoard(notesDir))`. On a `ConfigFileError`, return without touching the cache.
  2. For each chunk of 50 keys, call `jira.search(\`key in (${chunk.join(",")})\`, chunk.length)`. A `JiraError` with status 400 means every key in that chunk is treated as unreturned. Any other `JiraError` is recorded as the cache `error`, the previous tickets are kept, and step 3 is skipped for that chunk.
  3. For each unreturned key:
     - if the not-found state is under 24 hours old, skip it
     - otherwise call `jira.getIssueDetail(key)`:
       - a ticket whose key differs is a rename: call `renameInBoard`, and if note or groom files exist under the old key, also `notes.renameKey(old, new)`; emit `note`, `groom` and `board`, and keep the ticket
       - the same key means keep the ticket
       - a 404 records `{at, notFound: true}`
       - another error skips the key this round
     - the state file is `statePath`, a JSON `{ notFound: Record<key, string /*ISO*/> }`; missing or corrupt means empty; it is written with `atomicWrite`
  4. Write the `_board` cache `{fetchedAt: now ISO, tickets, error}`, call `notes.ensureIdentity` for tickets that have note or groom files, and emit `{type: "board"}`.
- `RefresherDeps` gains an optional `board?: { refresh(): Promise<void>; tickets(): Promise<Map<string, Ticket>>; rename(oldKey: string, newKey: string): Promise<void> }`. In `runAll`:
  - after the views, run `board.refresh()` (with try/catch and `console.error`)
  - `seen` = view tickets merged with `board.tickets()`
  - for each reconcile rename `[old, new]`, call `board.rename(old, new)`

- [ ] **Step 1: Write the failing tests** with a fake `JiraClient` and a temp `notesDir`:
  - Three starred keys, all returned by `search`: the cache has 3 tickets and the `board` event fires.
  - One key deleted:
    - `search` throws `JiraError(400)` for the chunk
    - `getIssueDetail` returns two tickets and a `JiraError(404)` for `GONE-1`
    - `view()` shows `GONE-1` with `missing: true` and the other two with rows
    - a second `refresh()` within 24 hours makes no `getIssueDetail("GONE-1")` call
  - Rename with no note file: `search` omits `OLD-1`, and `getIssueDetail("OLD-1")` returns a ticket keyed `NEW-1`. `board.yaml` now has `NEW-1` in `OLD-1`'s old position, and no note file was created.
  - Rename with a note file: same as above, plus the note has moved to `jira/notes/NEW-1.md`.
  - `apply({op: "add", key: "X-1"})` with `X-1` in no cache starts a refresh. Assert `search` was called after awaiting a tick.
  - `view()` on a broken `board.yaml` returns `locked: true` with an error naming `board.yaml`.
  - A just-starred key that is only in a view cache gets a `row` built from that view's ticket.
  - In `test/refresher.test.ts`:
    - with a fake `board` dep, `runAll` calls `board.refresh` after the views
    - a board-only ticket present in `board.tickets()` is not reported as an orphan
    - a reconcile rename calls `board.rename`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: board service — key-based refresh, not-found memory, renames`.

---

### Task 3: Board API routes and wiring

**Files:**
- Modify: `src/server/app.ts`, `src/server/main.ts`, `test/app.test.ts`

**Interfaces:**
- Consumes: `BoardService` (Task 2), and `BoardOpError` and `ConfigFileError` (Task 1).
- `AppDeps` gains `board: BoardService`.
- Routes (all existing security gates apply):

| Method & path | Behaviour |
|---|---|
| `GET /api/board` | `board.view(customIds, viewIds)`, where custom ids come from `loadColumns` and view ids from `loadViews`. If the columns or views can't be loaded, use `[]` for them and still serve the board. Returns `BoardResponse`. |
| `POST /api/board/ops` | Body is a `BoardOp`. Validate its shape: `op` must be one of the four, `key` a string, `column` a string, and `index` a non-negative integer. Then call `board.apply`. Returns 200 with `BoardResponse`. Responses: 400 `{error}` on a shape error or `BoardOpError`; 409 `{error}` on a `ConfigFileError`, with nothing written. |
| `POST /api/board/refresh` | `await board.refresh()`, then the same as `GET`. |

- `main.ts`:
  - constructs `BoardService` with `statePath: <notesDir>/.cache/board-state.json` and `onChange: (e) => broadcast(e)`
  - passes it to `createApp` and to `Refresher` as `board`
  - the existing startup `refreshAll()` covers the first board refresh

- [ ] **Step 1: Write the failing tests** in `test/app.test.ts`:
  - `GET /api/board` on a fresh data dir returns 4 columns, empty cards and `locked: false`.
  - `POST /api/board/ops` with `{op:"add", key:"PAY-1"}` returns 200, the Backlog cards have `key: "PAY-1"`, and `board.yaml` contains `PAY-1`.
  - A `move` to `"Doing"` at `0` returns 200 and the card is in Doing.
  - `{op:"move", key:"PAY-1", column:"Nope", index:0}` returns 400.
  - `{op:"add", key:"../x"}` returns 400.
  - `{op:"explode"}` returns 400.
  - `index: -1` returns 400.
  - With `board.yaml` corrupted: `GET` returns 200 with `locked: true`, an `add` returns 409, and the file is byte-identical.
  - The `Origin` and `Content-Type` gates apply to `/api/board/ops`: `text/plain` gives 415.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, then boot-check `main.ts` as in phase 1: a temp env file and NOTES_DIR, `curl /api/board`, then stop the server **by PID only**.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: board API routes`.

---

### Task 4: ★ column in table views

**Files:**
- Modify: `src/web/api.ts`, `src/web/table.ts`, `src/web/main.ts`, `src/web/styles.css`

**Interfaces:**
- Consumes: the Task 3 routes, and the `BoardResponse` and `BoardOp` types.
- Produces:
  - in `api.ts`:
    - `api.board(): Promise<BoardResponse>`
    - `api.boardOp(op: BoardOp): Promise<BoardResponse>`, which throws `Error(body.error)` on a non-2xx response
    - `api.refreshBoard(): Promise<BoardResponse>`
  - `TableHandlers` gains `star?: { isStarred(key: string): boolean; toggle(key: string): void; disabled: boolean }`
- Behaviour (call 2):
  - When `handlers.star` is given, `renderTable` renders a fixed, narrow first column. Its header is `★`, and each cell is a button: `★` (filled, accent colour) when starred, otherwise `☆` muted.
    - The button has `aria-pressed` and the title "Add to my board" or "Remove from my board".
    - It is disabled when `disabled` is set, with the title "board.yaml has an error".
  - `main.ts` keeps `boardKeys: Set<string>` and `boardLocked`. They are loaded at start through `api.board()` and reloaded on `board` live events.
  - Toggling is optimistic: update the set and re-render, then `api.boardOp({op: starred ? "remove" : "add", key})`. On failure, revert and show the error in `saveError`.
  - The star column is not part of `view.columns`, so the view editor and `views.yaml` are untouched.
- [ ] **Step 1: Build:** `npm run build && npm test && npm run typecheck`. Expected: clean.
- [ ] **Step 2: Smoke run**, following `.superpowers` ui-rules practice: fake NOTES_DIR with a seeded view cache. `POST /api/board/ops` an `add` with `curl`, then `GET /api/board` shows it, and the served `table.js` contains the star column code.
- [ ] **Step 3: Commit** `feat: star tickets onto the board from table views`.

---

### Task 5: Board view

**Files:**
- Create: `src/web/board.ts`
- Modify: `src/web/main.ts`, `src/web/styles.css`, `README.md`

**Interfaces:**
- Consumes:
  - `api.board`, `api.boardOp` and `api.refreshBoard` (Task 4)
  - `editNote(cell, row, onDone, {rows?})`, `isEditing` and `onEditorsIdle` from `editors.ts`
  - `openDrawer(key)` from `drawer.ts`
  - `h`, `relativeTime` and `copyToClipboard` from `dom.ts`
- Produces:
  - `renderBoard(container: HTMLElement, data: BoardResponse, handlers: BoardHandlers): void`
  - `interface BoardHandlers { onOpen(key: string): void; onOp(op: BoardOp): void; onNoteSaved(): void; onRefresh(): void; refreshing: boolean }`

Behaviour (calls 5, 6 and 8, plus the approved mockup):
- **Tab and switching:**
  - `main.ts` renders a final tab, `★ My board`, with the special id `__board`. It is never a view id, because the view-id regex forbids `_`. The tab is remembered in `localStorage` like the others.
  - When it is active, the view header shows `Last refreshed …` and a Refresh button (`api.refreshBoard`). The filter bar and JQL bar are hidden, and the table container is replaced by the board.
  - `locked` shows `error` in the red bar and disables every board control.
- **Lanes:** one lane per column, in order. The lane header shows the column name and a card count. The `archiveColumn` lane has an `Archive all` button, which is hidden when the lane is empty. The first click changes the button to `Archive N cards?`; the second click within 4 seconds sends `{op: "archive"}`. Otherwise the button resets.
- **Cards:**
  - Line 1: the key in monospace, plus the title as a link-styled `<button>` that calls `onOpen(key)`.
  - Line 2: the status pill, plus a readiness pill when `row.groom` exists, plus the orange stale dot when `row.flags.jiraNewerThanNote` is set.
  - Below that: a dashed note box clamped to 3 lines (`-webkit-line-clamp` with `line-clamp`), or `+ add note`. A click calls `editNote(box, row, onNoteSaved, {rows: 4})`.
  - A ✕ button shows on hover and focus and sends `{op: "remove", key}`.
  - `row === null` with `missing`: the key plus the text "not found in Jira" in muted text, and the ✕ only.
  - `row === null` without `missing`: the key plus "loading…".
- **Drag and drop:**
  - Cards are `draggable` (but not while an editor is open).
  - `dragover` on a lane computes the insertion index from the cursor's Y position against the card midpoints, and shows a 3px accent drop marker.
  - `drop` sends `{op: "move", key, column, index}`. The index is computed after removing the dragged card from its own lane when it's the same lane.
  - It is optimistic: `main.ts` reorders locally and re-renders, then applies the server response. On error, it reloads the board and shows `saveError`.
- **Keyboard:** a focused card (`tabindex=0`) responds to:
  - Alt+←/→: move to the previous or next column, at the end
  - Alt+↑/↓: move up or down one place
  - Enter: open the drawer
- **Live and rendering:**
  - `board`, `note` and `groom` live events reload `api.board()` while the board tab is active.
  - Renders defer while `isEditing()`, using the same pattern as the table.
- **Styles:** use `board-`/`card-` prefixed class names. Check them for Tailwind collisions.
- **README:** add a "My board" section. Cover how to star, how the columns in `board.yaml` work, and that Archive keeps notes. Add a "Using your board with Claude" subsection with the example ask from call 10.

- [ ] **Step 1: Build:** `npm run build && npm test && npm run typecheck`. Expected: clean. Grep `public/app.css` for the new classes.
- [ ] **Step 2: Smoke run:**
  - Seed a fake NOTES_DIR with a `board.yaml` (3 keys across 2 columns), the `_board` cache (2 tickets), and one not-found state entry.
  - `curl` checks: `/`, `/js/web/board.js`, `/api/board` (cards, `missing`, `row: null`), and the `move` and `archive` operations.
  - Stop the server by PID.
- [ ] **Step 3: Commit** `feat: personal board view with drag and drop`.

---

## Acceptance (user, real browser and real Jira)

The spec's "Done looks like" list, run in Firefox against the user's SCRUM project.

---

### Task 6: Header ticket search, drawer ★, note → noteColumn

**Spec:** the "Addendum: ticket search" section.

**Files:**
- Modify: `src/server/board.ts`, `test/board.test.ts`, `examples/board.example.yaml`, `src/shared/types.ts`, `src/web/main.ts`, `src/web/drawer.ts`, `src/web/styles.css`, `README.md`

**Interfaces:**
- `BoardFile` gains `noteColumn: string`.
  - `parseBoard` defaults it to `"Doing"` when that column exists, otherwise to the first column.
  - It throws `ConfigFileError` when the value is set but isn't in `columns`.
  - `serialiseBoard` writes it after `archiveColumn`.
  - The example gains `noteColumn: Doing`.
- `BoardResponse` gains `noteColumn: string`.
- `openDrawer(key: string, opts?: { fromSearch?: boolean }): void`.
- The drawer hooks gain:
  - `star?: { isStarred(key): boolean; toggle(key): void; disabled: boolean }`
  - `onNoteSavedFromSearch?(key: string, body: string): void`

**Behaviour:**
- **Header search:** a `<form>` holding a small `<input>` with the placeholder `Ticket key…`, in the tabs bar on the right.
  - On submit, trim and upper-case the input.
  - If `!isValidKeyClient(key)`, show the hint "Enter a key like ABC-123". `isValidKeyClient` mirrors the server regex `/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/` and is exported from `src/shared/rowOps.ts`.
  - Otherwise, call `openDrawer(key, {fromSearch: true})`.
- **Drawer ★:** a button in the drawer header with the same look and states as the table ★. It is disabled while `board.yaml` is locked.
- **Note implies Doing:**
  - The trigger: the drawer was opened with `fromSearch`, the key is not on the board, and a note save succeeds with a non-empty body.
  - `main.ts` then sends `{op: "move", key, column: board.noteColumn, index: Number.MAX_SAFE_INTEGER}` and updates `boardKeys`. The server clamps the index.
  - Tickets already on the board are never moved by a note save.
- **Tests:**
  - `parseBoard` `noteColumn` defaulting:
    - with Doing present → `"Doing"`
    - with `columns: [A, B]` → `"A"`
    - with `noteColumn: Nope` → `ConfigFileError`
  - The round trip includes `noteColumn`.
  - `isValidKeyClient` mirrors `isValidKey` on the same cases as `test/notesStore.test.ts`.

- [ ] **Step 1:** Write the failing tests, run them, implement the server and shared parts, then run `npm test`. Expected: PASS.
- [ ] **Step 2:** Build the UI. Run `npm run build && npm test && npm run typecheck`. Expected: clean. Grep the new classes in `app.css`.
- [ ] **Step 3:** Smoke run: the served `main.js` contains the search form, and `GET /api/board` includes `noteColumn`.
- [ ] **Step 4:** Commit `feat: header ticket search, drawer star, note adds to Doing`.

---

### Task 7: "Note updated" and "Groomed" columns

Requested by the user in chat (2026-10-24): local timestamps you can sort on, for table views.

**Files:**
- Modify: `src/shared/types.ts` (`BuiltinColumnId`, `BUILTIN_COLUMNS`), `src/shared/rowOps.ts` (`cellValue`), `src/web/cells.ts`, `test/rowOps.test.ts`, `README.md`, `src/server/configFiles.ts` only if column validation needs it

**Interfaces:**
- `BuiltinColumnId` gains `"noteUpdated"` and `"groomed"`. `BUILTIN_COLUMNS` gains `{ id: "noteUpdated", label: "Note updated" }` and `{ id: "groomed", label: "Groomed" }`. These are appended, so existing views are unchanged, and both are available in the view editor's column picker.
- `cellValue(row, "noteUpdated")` returns `row.note?.mtimeMs ?? null`, a number.
- `cellValue(row, "groomed")` returns `Date.parse(row.groom.groomedAt)`, or `null` when there's no groom or the date can't be parsed.
- `sortRows` already sorts numbers numerically and puts nulls last.
- Cells render `relativeTime` (from `src/web/dom.ts`) of the timestamp, with a `title` holding `new Date(ms).toLocaleString()`. They are empty when the value is null.

- [ ] **Step 1:** Write the failing tests in `test/rowOps.test.ts`:
  - `cellValue` for both new ids, with and without a note or groom
  - `sortRows` by `noteUpdated` descending puts the newest first and the no-note rows last
- [ ] **Step 2:** Run `npm test`. Expected: FAIL. Then implement, and run `npm run build && npm test && npm run typecheck`. Expected: clean.
- [ ] **Step 3:** Add the two columns to the README's column list.
- [ ] **Step 4:** Commit `feat: sortable Note updated and Groomed columns`.
