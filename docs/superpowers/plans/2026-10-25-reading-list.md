# Reading List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Reading tab (third, after Kanban and Scratchpad) where pasting a URL adds an item. Items have a status, a category, linked tickets, a note, an optional Claude summary, and a ★ that puts them on the Kanban.

**Architecture:**
- Each item is a markdown file `NOTES_DIR/reading/items/<id>.md`: front matter holds the fields, and the body is the user's note. Claude's output goes to `NOTES_DIR/reading/groom/<id>.md`. Configuration is in `NOTES_DIR/reading.yaml`.
- A `ReadingStore` on the server owns the files. The routes live under `/api/reading`, and the watcher emits live events for changes.
- The Kanban stores reading cards as `reading:<id>` next to ticket keys.
- On the web side there's a reading tab module and a reading side panel module. Both reuse the existing panel, table and menu CSS, and a note editor generalised from `editNote`.

**Tech Stack:** Node ≥ 22.18 running TypeScript directly, `node --test`, `yaml`, `marked` (through `renderMarkdownSafe`), vanilla TS DOM built with `h()`, and Tailwind CSS layers in `src/web/styles.css`.

**Spec:** `docs/superpowers/specs/2026-10-25-reading-list-design.md`. Read it first. It holds the decisions this plan relies on, including the copy wording, `reading.yaml` defaults and the front-matter shape.

## Global Constraints

- Network: no request except the existing Jira calls. Never fetch the linked page, its favicon or a preview.
- Only `http:` and `https:` URLs are accepted.
- Item ids match `/^[a-z0-9][a-z0-9-]{0,79}$/`. An id is fixed at creation and never changes when the title is edited.
- Every file write goes through `atomicWrite`. The app never overwrites a note body it didn't get from the user. Front-matter rewrites keep the body byte-for-byte.
- Deleting an item moves its files to `NOTES_DIR/.cache/trash/reading/`. Nothing is ever unlinked outright.
- Examples, tests, docs and commits use generic names only (`acme`, `PAY`, `Architecture`). Never use the user's real spaces, options or people.
- Icons are Heroicons-style 24px outline paths with a 1.5 stroke and no fill, added to `PATHS` in `src/web/icons.ts`.
- Everything must work in all ten themes. Use the existing CSS tokens; no new colours.
- Mutating routes keep the app's existing Origin and `Content-Type: application/json` checks. Nothing here bypasses `handle()`.

## Review Focus

1. **A URL already on the list, written differently** (trailing slash, surrounding whitespace, different case in the host). Expected: no duplicate is added and the existing item opens. Pinned in Task 1 (`normaliseUrl`) and Task 3 (`add` returns `existed: true`).
2. **Front matter broken by a hand edit in Obsidian.** Expected: the item still lists, shown with its id as its title and a parse-error marker. Field and note writes are refused with 422, and the file is never rewritten. Pinned in Task 3.
3. **A status that's no longer in `reading.yaml`** (renamed in the file). Expected: the item keeps its value, appears under All, and isn't counted in any status sub-tab. Pinned in Task 1 (`filterReading`).
4. **Two saves racing on one item:** a field change from the panel while the note is being saved. Expected: neither change is lost. Field writes re-read the file and keep the current body; note writes use the `baseMtimeMs` conflict check. Pinned in Task 3.
5. **A `reading:` card whose file was deleted on disk.** Expected: the card shows as missing, can still be removed, and board refresh doesn't send it to Jira. Pinned in Task 5.

---

### Task 1: Shared reading types and pure helpers

**Files:**
- Modify: `src/shared/types.ts` (append the reading types; extend `BoardCard` and `LiveEvent`)
- Create: `src/shared/reading.ts`
- Test: `test/reading.test.ts`

**Interfaces:**
- Produces, in `src/shared/types.ts`:
  ```ts
  export type ReadingSource = "confluence" | "slack" | "video" | "web";
  export interface ReadingConfig { statuses: string[]; doneStatus: string; categories: string[]; prompts: string[]; groomPrompt: string }
  export interface ReadingSummary { id: string; title: string; status: string; url: string; source: ReadingSource }
  export interface ReadingItem extends ReadingSummary {
    category: string | null; tickets: string[]; created: string; updated: string; // updated = file mtime, ISO
    mtimeMs: number; note: string; groom: { summary: string; groomedAt: string } | null; parseError: string | null;
  }
  export interface ReadingListResponse { items: ReadingItem[]; config: ReadingConfig; error: string | null }
  // BoardCard gains:  reading?: ReadingSummary | null   (present only for reading: cards; null = file missing)
  // LiveEvent gains:  | { type: "reading" | "readingGroom"; id: string } | { type: "readingConfig" }
  ```
- Produces, in `src/shared/reading.ts`:
  - `READING_PREFIX = "reading:"`
  - `isReadingId(id: string): boolean`
  - `readingCardKey(id: string): string`
  - `readingIdFromCard(card: string): string | null`
  - `normaliseUrl(input: string): string | null`: trims; returns `null` unless the protocol is http or https; lower-cases the host; drops one trailing `/` from the path when there's no query or hash.
  - `guessFromUrl(url: string, jiraBaseUrl: string | null): { title: string; source: ReadingSource }`
  - `makeReadingId(createdIso: string, title: string, taken: ReadonlySet<string>): string`
  - `filterReading(items: ReadingItem[], f: { status: string | null; category: string | null; ticket: string | null }): ReadingItem[]`. A `status` of `null` means All.
  - `sortReading(items: ReadingItem[], by: ReadingSortKey, dir: "asc" | "desc"): ReadingItem[]`, where `type ReadingSortKey = "title" | "status" | "category" | "tickets" | "groomed" | "updated" | "created"`.

- [ ] **Step 1: Write the failing tests** in `test/reading.test.ts`:

```ts
test("normaliseUrl trims, lower-cases host, drops a lone trailing slash, rejects non-http(s)", () => {
  assert.equal(normaliseUrl("  https://Acme.Atlassian.net/wiki/x/ "), "https://acme.atlassian.net/wiki/x");
  assert.equal(normaliseUrl("https://acme.example/a/?q=1"), "https://acme.example/a/?q=1");
  assert.equal(normaliseUrl("javascript:alert(1)"), null);
  assert.equal(normaliseUrl("ftp://x"), null);
  assert.equal(normaliseUrl("not a url"), null);
});
test("guessFromUrl: Confluence page title from the slug", () => {
  assert.deepEqual(guessFromUrl("https://acme.atlassian.net/wiki/spaces/PAY/pages/123/Retry+strategy+for+card+captures", "https://acme.atlassian.net"),
    { title: "Retry strategy for card captures", source: "confluence" });
  assert.deepEqual(guessFromUrl("https://acme.atlassian.net/wiki/spaces/PAY/pages/123/Caf%C3%A9+notes", null), { title: "Café notes", source: "confluence" });
  assert.deepEqual(guessFromUrl("https://acme.atlassian.net/wiki/x/AbCd", null), { title: "acme.atlassian.net: AbCd", source: "confluence" });
});
test("guessFromUrl: Slack, video and other web", () => {
  assert.deepEqual(guessFromUrl("https://acme.slack.com/archives/C123/p456", null), { title: "Slack thread", source: "slack" });
  assert.deepEqual(guessFromUrl("https://www.youtube.com/watch?v=abc", null), { title: "Video: watch", source: "video" });
  assert.deepEqual(guessFromUrl("https://www.loom.com/share/xyz", null), { title: "Video: xyz", source: "video" });
  assert.deepEqual(guessFromUrl("https://blog.example.com/posts/idempotency-keys/", null), { title: "blog.example.com: idempotency-keys", source: "web" });
  assert.deepEqual(guessFromUrl("https://example.com/", null), { title: "example.com", source: "web" });
});
test("makeReadingId slugs the title under the created date and avoids collisions", () => {
  assert.equal(makeReadingId("2026-10-25T10:02:00Z", "Retry strategy: card captures!", new Set()), "2026-10-25-retry-strategy-card-captures");
  assert.equal(makeReadingId("2026-10-25T10:02:00Z", "Retry", new Set(["2026-10-25-retry"])), "2026-10-25-retry-2");
  assert.equal(makeReadingId("2026-10-25T10:02:00Z", "!!!", new Set()), "2026-10-25-item");
  assert.ok(makeReadingId("2026-10-25T10:02:00Z", "x".repeat(200), new Set()).length <= 80);
  assert.ok(isReadingId(makeReadingId("2026-10-25T10:02:00Z", "Café ünïcode", new Set())));
});
test("reading card keys round-trip and never look like ticket keys", () => {
  assert.equal(readingIdFromCard(readingCardKey("2026-10-25-a")), "2026-10-25-a");
  assert.equal(readingIdFromCard("PAY-1"), null);
  assert.equal(readingIdFromCard("reading:Bad Id"), null);
});
// fixtures: a = { status: "Pending", category: "RFC", tickets: ["PAY-1"], created: "2026-10-01T00:00:00Z", groom: null }
//           b = { status: "Complete", category: null, tickets: [], created: "2026-10-03T00:00:00Z", groom: { groomedAt: "2026-10-04T00:00:00Z" } }
//           c = { status: "Read", category: "RFC", tickets: ["PAY-1", "PAY-2"], created: "2026-10-02T00:00:00Z", groom: { groomedAt: "2026-10-05T00:00:00Z" } }
test("filterReading: status null is All; category and ticket filters AND together", () => {
  assert.deepEqual(ids(filterReading([a, b, c], { status: null, category: null, ticket: null })), ["a", "b", "c"]);
  assert.deepEqual(ids(filterReading([a, b, c], { status: "Pending", category: null, ticket: null })), ["a"]);
  assert.deepEqual(ids(filterReading([a, b, c], { status: null, category: "RFC", ticket: "PAY-2" })), ["c"]);
});
test("sortReading: created desc; groomed desc puts items without a groom last", () => {
  assert.deepEqual(ids(sortReading([a, b, c], "created", "desc")), ["b", "c", "a"]);
  assert.deepEqual(ids(sortReading([a, b, c], "groomed", "desc")), ["c", "b", "a"]);
  assert.deepEqual(ids(sortReading([a, b, c], "groomed", "asc")), ["b", "c", "a"]);
});
```

Items without a groom sort last in both directions.

Video hosts: `youtube.com`, `youtu.be`, `vimeo.com`, `loom.com`, and any host containing `stream` together with `microsoft` or `sharepoint`. Matching ignores a leading `www.`. The "Video:" title uses the last non-empty path segment, decoded.

Confluence: the URL's path starts with `/wiki/` and either the host matches `jiraBaseUrl`'s host or the host ends in `.atlassian.net`.

Slugging: NFKD-normalise, strip combining marks, lower-case, collapse each run of non-`[a-z0-9]` characters into `-`, trim `-` from both ends, and use `item` if nothing is left. Truncate the whole id to 80 characters without leaving a trailing `-`. The collision suffix `-2`, `-3` and so on must also fit within 80 characters.

- [ ] **Step 2: Run** `node --test test/reading.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the types and `src/shared/reading.ts`. It must have no Node imports, because the web build compiles `src/shared`.
- [ ] **Step 4: Run** `node --test test/reading.test.ts && npm run typecheck`. Expected: PASS, with no type errors. Code that switches over `LiveEvent` may need a no-op case so it still compiles.
- [ ] **Step 5: Commit** with `feat(reading): shared types, URL guessing, ids, filter and sort`.

---

### Task 2: `reading.yaml` config

**Files:**
- Create: `examples/reading.example.yaml`. Content is exactly the spec's `reading.yaml` block.
- Modify: `src/server/configFiles.ts`. Add `"reading"` to the list that `ensureDataDir` creates; add `"reading/items"` and `"reading/groom"` to the directories it creates; add `loadReadingConfig`.
- Test: `test/configFiles.test.ts` (append)

**Interfaces:**
- Produces `loadReadingConfig(notesDir: string): Promise<ReadingConfig>`. A missing file returns the spec defaults. A broken file throws `ConfigFileError`.
- Produces `DEFAULT_READING_CONFIG: ReadingConfig`, exported for tests and for the app's fallback.

- [ ] **Step 1: Write the failing tests:**
  - `ensureDataDir creates reading.yaml from the example and the reading folders`
  - `loadReadingConfig: missing file gives the defaults (statuses Pending, Open questions, Complete; doneStatus Complete)`
  - `loadReadingConfig: doneStatus must be one of statuses` (throws `ConfigFileError`)
  - `loadReadingConfig: statuses must be a non-empty list of unique non-empty strings` (throws)
  - `loadReadingConfig: doneStatus defaults to the last status; categories and prompts default to []; groomPrompt defaults to DEFAULT_READING_CONFIG.groomPrompt`
- [ ] **Step 2: Run** `node --test test/configFiles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `readYaml` and `strOrNull`, in the same style as `loadColumns`.
- [ ] **Step 4: Run** `node --test test/configFiles.test.ts test/app.test.ts`. Expected: PASS. `app.test.ts` uses `ensureDataDir` with `examples/`, so it proves the new example file exists.
- [ ] **Step 5: Commit** with `feat(reading): reading.yaml config with defaults and validation`.

---

### Task 3: `ReadingStore` (files, front matter, writes, delete, renames)

**Files:**
- Create: `src/server/readingStore.ts`
- Test: `test/readingStore.test.ts`

**Interfaces:**
- Consumes the Task 1 helpers and types; `atomicWrite`, `WriteResult` and `NoteFile` from `notesStore.ts`; `parseFrontMatter`, `stringifyFrontMatter` and `isValidKey` from `frontMatter.ts`.
- Produces `class ReadingStore`, constructed with `new ReadingStore(notesDir: string)`. Its methods:
  - `itemPath(id: string): string`
  - `groomPath(id: string): string`
  - `notePath(id: string): string` (same as `itemPath`, for the copy prompt)
  - `list(): Promise<ReadingItem[]>`
  - `read(id: string): Promise<ReadingItem | null>`
  - `add(url: string, opts: { jiraBaseUrl: string | null; defaultStatus: string; now: Date }): Promise<{ item: ReadingItem; existed: boolean }>`. Throws `InvalidUrlError` when `normaliseUrl` returns null.
  - `setFields(id: string, patch: ReadingPatch): Promise<WriteResult>`, where `type ReadingPatch = Partial<{ title: string; url: string; status: string; category: string | null; tickets: string[] }>`
  - `writeNote(id: string, body: string, opts: { baseMtimeMs: number | null; force?: boolean }): Promise<WriteResult>`
  - `remove(id: string): Promise<boolean>`. Moves `items/<id>.md` and `groom/<id>.md` to `.cache/trash/reading/<id>[-groom].<timestamp>.md`, and returns false when the item doesn't exist.
  - `renameTicketKey(oldKey: string, newKey: string): Promise<string[]>`. Returns the ids it rewrote.
  - `ticketIndex(): Promise<Map<string, ReadingSummary[]>>`. Maps each ticket key to the items that link it, in title order.
- Also exports `class InvalidUrlError extends Error` and `type ReadingPatch`.

Front matter is written in this key order: `id, url, title, status, category?, tickets, links, source, created`. `links` is always regenerated from `tickets` as `[[jira/tickets/KEY|KEY]]`. Ticket keys are upper-cased and validated with `isValidKey`. Invalid keys in a patch are rejected with `InvalidKeyError`; invalid keys found in a file are ignored when read. `updated` is the file mtime as ISO. `created` falls back to birthtime, then mtime.

Groom summary works like `notesStore`'s `summarise`: front-matter `summary`, or the first non-empty line with heading marks stripped. `groomedAt` is `groomed_at`, or the groom file's mtime.

A file with a front-matter parse error lists with `title = id`, `status = ""`, `parseError` set and `note = ""`. `setFields` and `writeNote` return `{ ok: false, reason: "parse-error" }` for it.

- [ ] **Step 1: Write the failing tests:**
  - `add creates items/<id>.md with guessed title, default status, tickets [] and links []`: assert the exact file text for a Confluence URL with `now = 2026-10-25T10:02:00Z`.
  - `add with the same URL written differently returns the existing item with existed: true and writes nothing`: compare mtimes before and after.
  - `add rejects javascript: and ftp: URLs with InvalidUrlError`
  - `setFields regenerates links from tickets, upper-cases keys, and keeps the body byte-for-byte`
  - `setFields with category null removes the category key`
  - `setFields rejects an invalid ticket key with InvalidKeyError and leaves the file unchanged`
  - `writeNote with a stale baseMtimeMs returns conflict with the current file; force overwrites; fields are kept`
  - `a field write between two note saves is not lost`: `writeNote(A)`, `setFields({ status })` and `writeNote(B, base = mtime after setFields)` leave a file with body B and the new status.
  - `a hand-broken front matter lists with parseError, and setFields/writeNote return parse-error without touching the file`
  - `list reads groom summary and groomedAt from reading/groom/<id>.md`
  - `remove moves item and groom files under .cache/trash/reading and list no longer shows it`
  - `renameTicketKey rewrites tickets and links only in items that reference the old key; body unchanged; returns their ids`
  - `renameTicketKey skips a file with a parse error`
  - `ticketIndex maps PAY-40 to the two items that link it`
- [ ] **Step 2: Run** `node --test test/readingStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Read files the same way as `NotesStore.readFile`: one handle for read and stat, retried once if the mtime moves.
- [ ] **Step 4: Run** `node --test test/readingStore.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(reading): ReadingStore with conflict-safe writes, trash and key renames`.

---

### Task 4: API routes, live events and wiring

**Files:**
- Modify:
  - `src/server/app.ts`: add `reading: ReadingStore` to `AppDeps`, plus the routes below.
  - `src/server/watcher.ts`: add to `eventForPath`.
  - `src/server/main.ts`: construct `ReadingStore` and pass it to `createApp`.
  - `src/server/copyText.ts`: add the copy helpers.
- Test: `test/app.test.ts`, `test/watcher.test.ts` (create it if `eventForPath` tests live elsewhere; check with `grep -l eventForPath test/`), and `test/copyText.test.ts`.

**Interfaces:**

| Route | Request body | Responses |
|---|---|---|
| `GET /api/reading` | none | `ReadingListResponse`. When `reading.yaml` is broken, `config` is `DEFAULT_READING_CONFIG` and `error` holds the message. |
| `POST /api/reading` | `{ url: string }` | 201 `{ item, existed: false }`, 200 `{ item, existed: true }`, 400 `{ error: "Enter a link starting with http:// or https://" }` |
| `PUT /api/reading/<id>` | a `ReadingPatch` | 200 `{ mtimeMs }`, 409, 422 (as `sendWrite`), 404 for an unknown id. Unknown `status` or `category` values are rejected with 400 only when `reading.yaml` parses. While it's broken, every field write returns 409, like views. |
| `PUT /api/reading/<id>/note` | `{ body, baseMtimeMs, force? }` | Same as `PUT /api/notes/<key>` |
| `DELETE /api/reading/<id>` | none | 204, or 404 |
| `GET /api/reading/<id>/copy/<kind>` | none | `kind ∈ link | note | both | prompt`; `text/plain` |

- `DELETE` must also pass the existing Origin check. `handle()` already requires `Content-Type: application/json` for non-GET requests, so the client sends `{}`.
- `<id>` failing `isReadingId` returns 400 `Invalid reading id`.
- The `GET /api/tickets/<KEY>` response gains `reading: ReadingSummary[]` from `reading.ticketIndex()`.
- Watcher mapping:
  - `reading/items/<id>.md` → `{ type: "reading", id }`
  - `reading/groom/<id>.md` → `{ type: "readingGroom", id }`
  - `reading.yaml` → `{ type: "readingConfig" }`
  - Ids are checked with `isReadingId`.
- `copyText.ts` gains:
  - `readingLinkMarkdown(item: ReadingItem): string`, which returns `[title](url)`
  - `readingBothMarkdown(item: ReadingItem, groomBody: string | null): string`: an `# title` heading, the URL, Status, Category and Tickets lines, `## My note`, then `## Claude summary` when a groom exists.
  - `readingPrompt(template: string, vars: { url: string; title: string; tickets: string; groomPath: string; notePath: string }): string`. `tickets` is a comma-separated list, or `none`.

- [ ] **Step 1: Write the failing tests:**
  - app: `POST /api/reading adds an item, and a second POST of the same URL returns existed: true`
  - app: `POST /api/reading without the JSON content type is 415`
  - app: `PUT /api/reading/<id> sets status and tickets; a status not in reading.yaml is 400`
  - app: `PUT /api/reading/<id>/note conflict returns 409 with current`
  - app: `DELETE /api/reading/<id> moves it to the trash; a second DELETE is 404`
  - app: `GET /api/reading/<id>/copy/prompt fills url, title, tickets, groomPath and notePath`
  - app: `GET /api/tickets/PAY-1 includes reading items that link PAY-1`
  - app: `a file written under reading/items broadcasts { type: "reading", id }`. Follow the existing watcher-plus-broadcast test pattern in `app.test.ts`.
  - watcher: the three new mappings; `reading/items/Bad Id.md` maps to null; `.cache/trash/...` maps to null.
  - copyText: exact output of `readingBothMarkdown` for a fixture with and without a groom.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the routes in `api()`, alongside the ticket routes, in the same style.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(reading): /api/reading routes, copy text, live events`.

---

### Task 5: Kanban support for `reading:` cards

**Files:**
- Modify:
  - `src/server/board.ts`: `parseBoard` and `applyBoardOp`.
  - `src/server/boardService.ts`: `doRefresh`, `apply`, `view` and the deps.
  - `src/server/main.ts`: wiring.
  - `src/shared/boardOps.ts`: only if it validates keys; check it.
- Test: `test/board.test.ts`, `test/boardService.test.ts`

**Interfaces:**
- `parseBoard` accepts an entry when `readingIdFromCard(entry.trim())` is non-null, keeping it exactly as written with no upper-casing. Ticket keys are still upper-cased and validated, and anything else still gets the existing warning.
- `applyBoardOp` accepts `op.key` when it's a valid ticket key or a valid reading card key. The error message for anything else is unchanged.
- `BoardServiceDeps` gains:
  - `reading?: { summary(id: string): Promise<ReadingSummary | null>; markDone(ids: string[]): Promise<void> }`
- `main.ts` builds that dep from `ReadingStore`: `summary` uses `read`; `markDone` calls `loadReadingConfig` and then `setFields(id, { status: doneStatus })` for each item not already at `doneStatus`, skipping parse errors.
- `doRefresh` and `knownKeys` ignore reading card keys: they are never sent to Jira and never marked not-found.
- `apply({ op: "archive" })` collects the reading ids in `archiveColumn` before applying the op, then calls `reading.markDone(ids)` after `updateBoard`. If `markDone` fails, it's logged and the archive still succeeds.
- `view()` fills `card.reading` for reading cards. `row` is null and `missing` is `summary === null`.

- [ ] **Step 1: Write the failing tests:**
  - `parseBoard keeps reading:<id> entries as written and still upper-cases ticket keys`
  - `parseBoard drops reading:Bad Id with a warning`
  - `applyBoardOp add/move/remove work for reading:<id>`
  - `refresh never searches Jira for reading cards`: use a fake `jira.search` that records its JQL, and assert `reading:` doesn't appear.
  - `archive marks reading items in the archive column done and clears the column`: use a fake `reading.markDone` that records ids.
  - `view gives reading cards their summary, and a missing file shows missing: true`
- [ ] **Step 2: Run** `node --test test/board.test.ts test/boardService.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(reading): reading cards on the Kanban; archive marks them done`.

---

### Task 6: Ticket links (hub files and key renames)

**Files:**
- Modify:
  - `src/server/ticketFiles.ts`: `TicketFileContext` and `syncTicketFiles`.
  - `src/server/refresher.ts`: the renamed loop.
  - `src/server/boardService.ts`: the rename branch in `doRefresh`.
  - `src/server/main.ts`: wiring.
- Test: `test/ticketFiles.test.ts`, `test/refresher.test.ts`

**Interfaces:**
- `TicketFileContext` gains `reading: ReadingSummary[]`. `renderTicketFile` adds one line per item after the Groom line: `- Reading: [[reading/items/<id>|<title>]]`. The title is passed through `collapse`, and `|`, `[` and `]` are replaced with spaces.
- `syncTicketFiles` deps gain `getReadingIndex?: () => Promise<Map<string, ReadingSummary[]>>`. It defaults to an empty map.
- `RefresherDeps` and `BoardServiceDeps` gain `onTicketRenamed?: (oldKey: string, newKey: string) => Promise<void>`. Both call it wherever they already rename notes. `main.ts` wires it to `reading.renameTicketKey` and then broadcasts `{ type: "reading", id }` for each id returned.
- The ticket syncer must also run when reading items change: in `main.ts`, the watcher callback calls `ticketFiles.schedule()` for `reading` events as well.

- [ ] **Step 1: Write the failing tests:**
  - `renderTicketFile lists linked reading items as wikilinks after Groom`
  - `syncTicketFiles writes Reading lines from getReadingIndex`
  - `refresher calls onTicketRenamed for each reconcile rename`
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(reading): ticket hub files link reading; key renames follow into reading items`.

---

### Task 7: Reading tab (web): icon, tab, URL bar, sub-tabs, table, filters

**Files:**
- Modify:
  - `src/web/icons.ts`: add `eyeglasses` to `PATHS`. Use this path, which was checked at 16, 24 and 40px against `viewColumns` and `paintBrush`:
    ```
    M2.25 13.5a3.75 3.75 0 1 0 7.5 0 3.75 3.75 0 0 0-7.5 0Zm12 0a3.75 3.75 0 1 0 7.5 0 3.75 3.75 0 0 0-7.5 0Zm-4.5-.75a2.25 2.25 0 0 1 4.5 0M2.25 13.5 4.5 6.75h1.5m15.75 6.75L19.5 6.75H18
    ```
  - `src/web/api.ts`: add `readingList()`, `addReading(url)`, `saveReadingFields(id, patch)`, `saveReadingNote(id, body, base, force)`, `deleteReading(id)` and `readingCopy(id, kind)`.
  - `src/web/main.ts`: add `READING_TAB = "__reading"` to `isFixedTab` and `tabIndex`. The order becomes Kanban 0, Scratchpad 1, Reading 2, then views from 3. Render the tab button third, with `aria-label` and `title` set to `Reading list`. Handle the `reading`, `readingGroom` and `readingConfig` live events.
  - `src/web/styles.css`
- Create: `src/web/reading.ts`

**Interfaces:**
- Produces `renderReading(container: HTMLElement, state: ReadingTabState, handlers: ReadingHandlers): void` in `src/web/reading.ts`, plus `ReadingTabState`, `ReadingHandlers` and `focusReadingUrl(): void`.
- The URL bar is an `<input>` with the `.jql`-style field class, placeholder `Paste a link and press Enter…`, and a leading `link` icon.
  - On Enter, it calls `api.addReading`.
  - If the item is new, the bar clears and the new row is highlighted. A `.reading-new` class fades out using the existing motion tokens.
  - If the item already exists, the bar clears, the item's side panel opens, and a toast says `Already on your list`.
  - On a 400 response, the server's message appears under the bar in the `ticket-search-hint` style.
- Sub-tabs: one per status from config, then `All`. Each shows a count. The active one is stored in localStorage under `atlassian-notes.readingStatus`, wrapped in try/catch. Status counts only include items whose status is in config.
- Columns, in this order:
  1. ★: the existing `star-btn`, toggling `reading:<id>` on the board through the same `submitBoardOp` path that `toggleStar` uses.
  2. Title: a button that opens the panel, followed by a separate ↗ link (`target="_blank"`, `rel="noopener noreferrer"`).
  3. Status: a pill.
  4. Category: a pill.
  5. Tickets: `code.key` buttons that open the ticket side panel.
  6. Groomed: relative time, with the summary as the tooltip.
  7. Updated and Added: relative times.

  Rows with a parse error show a red `stale-dot` with the error as their tooltip.
- Filters: Category and Ticket selects in the filter-bar style. They're kept in memory only.
- Sorting: the default is `created` descending, and clicking a header toggles the sort, using `sortReading`.
- Empty states: `Nothing here yet. Paste a link above.` when there are no items; `Nothing in <status>.` for an empty sub-tab.

- [ ] **Step 1: Implement** the icon, API client and tab wiring. Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 2: Implement `reading.ts`** and its styles. Run `npm run build`. Expected: success.
- [ ] **Step 3: Check it manually in a browser.**
  - Start the server on a temporary notes folder: `NOTES_DIR=<tmp copy> PORT=4319 node src/server/main.ts`.
  - Paste a Confluence URL and press Enter: the row appears under Pending with the guessed title.
  - Paste the same URL again: the toast appears and no second row is added.
  - Paste `ftp://x`: the hint appears.
  - The sub-tab counts are right, and the active sub-tab survives a reload.
  - ★ adds the item to the Kanban.
  - Check the icon in two themes: carbon and catppuccin-latte.
- [ ] **Step 4: Commit** with `feat(reading): Reading tab with URL bar, status sub-tabs, table and filters`.

---

### Task 8: Reading side panel (web)

**Files:**
- Create: `src/web/readingDrawer.ts`
- Modify:
  - `src/web/editors.ts`: extract the generic editor.
  - `src/web/drawer.ts`: close the reading panel on open, and add the "Reading" section.
  - `src/web/styles.css`
  - `src/web/main.ts`: hooks.

**Interfaces:**
- In `editors.ts`, add `export interface EditableDoc { label: string; note: { body: string; mtimeMs: number } | null; save(body: string, baseMtimeMs: number | null, force: boolean): Promise<SaveResult> }` and `export function editMarkdown(cell: HTMLElement, doc: EditableDoc, onDone: () => void, options?: NoteEditorOptions): void`.
  - Move the body of `editNote` into `editMarkdown` unchanged. `editNote(cell, row, onDone, options)` becomes a thin wrapper that builds an `EditableDoc` from `row` and writes `row.note` back on success. Ticket behaviour must be identical; the existing tests and a manual edit check this.
- `readingDrawer.ts` exports:
  - `openReadingDrawer(id: string): void`
  - `closeReadingDrawer(): void`
  - `currentReadingId(): string | null`
  - `readingDrawerOnLive(id: string): void`, which behaves like `drawerOnLive`: it never replaces an open editor and shows the "Changed on disk" notice instead.
  - `configureReadingDrawer(hooks: ReadingDrawerHooks): void`, where `ReadingDrawerHooks = { getItem(id: string): ReadingItem | undefined; config(): ReadingConfig; locked(): boolean; star: DrawerHooks["star"]; onChanged(): void; openTicket(key: string): void }`.
- `openDrawer` (tickets) calls `closeReadingDrawer()` first, and `openReadingDrawer` calls `closeDrawer()` first, so only one panel is ever open.
- Panel layout reuses the `dr-*` classes:
  - Header: ★, an inline-editable title (Enter saves, Esc cancels), an `Open ↗` link, `Copy ▾` and a ⋯ menu with `Delete…`, and the close button.
  - Left column, Details section:
    - Status: a select of `config.statuses`. An unknown current value is shown as an extra disabled option.
    - Category: a select with `—` plus `config.categories`.
    - Tickets: chips with ✕, and `+ add` opening a small input. Enter validates with `isValidKeyClient` and saves; Esc cancels.
    - Source.
    - URL: inline-editable.
    - Added and Updated.
  - Right column:
    - `Reading prompts`: a muted list of `config.prompts`, hidden when empty.
    - `My note`: the note through `editMarkdown`, with `rows: 16`, placeholder text `No note yet. Click to add one.`
    - `Claude`: the groom summary and rendered body. When there's none, it shows `No summary yet. Use Copy → Prompt for Claude, then run it in Claude.` and the groom path.
- Rendered note and groom HTML: extend `GET /api/reading/<id>` (add this route in this task) to return `{ item, noteHtml, groomHtml, groomPath }` via `renderMarkdownSafe`. Add one app test, `GET /api/reading/<id> returns sanitised noteHtml`, asserting that `<script>` is stripped.
- Copy menu items:
  - `Link` → `link`
  - `My note` → `note`
  - `Item + note for Claude` → `both`
  - `Prompt for Claude` → `prompt`
- Delete opens `confirmDialog` with:
  - title: `Delete "<title>"?`
  - body: `Moves this item, your note and any Claude summary to .cache/trash/reading in your notes folder, and removes it from your Kanban.`
  - confirm button: `Delete`
- The ticket side panel gets a "Reading" section in its right column, above the note, when `payload.reading.length > 0`. Each entry is a button showing the glasses icon, title and status pill, which calls `hooks.openReading(id)`. `DrawerHooks` gains `openReading?(id: string): void`.
- While `reading.yaml` is broken, the field controls are disabled, with the config error as their tooltip. The note stays editable.

- [ ] **Step 1: Extract `editMarkdown`.** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 2: Add `GET /api/reading/<id>`** with its test. Run `npm test`. Expected: PASS.
- [ ] **Step 3: Implement `readingDrawer.ts`**, the ticket panel's Reading section and the styles. Run `npm run build`. Expected: success.
- [ ] **Step 4: Check it manually in a browser** on the temporary notes folder:
  - Open an item. Set the status, category and tickets, then reload: they persist.
  - Write a note. Edit the same file in a text editor while the panel is open: the notice appears, and the editor is untouched.
  - Each Copy item copies the right text.
  - Write a groom file by hand: it appears live.
  - Delete an item: its files land in `.cache/trash/reading` and the card leaves the Kanban.
  - Open a ticket the item is linked to: its panel lists the item.
  - Esc closes the panel, and opening a ticket from a chip swaps panels.
- [ ] **Step 5: Commit** with `feat(reading): reading side panel with fields, prompts, note, Claude summary, copy and delete`.

---

### Task 9: Kanban reading cards, palette, docs and final check

**Files:**
- Modify:
  - `src/web/board.ts`: render cards with `card.reading`.
  - `src/web/main.ts`: palette commands, and opening a reading card's panel.
  - `README.md`
  - `CLAUDE.md`: only if it lists the data folders; check with `grep -n reading/ CLAUDE.md`.
- Test: none new. This task is UI and docs, checked manually.

**Interfaces:**
- A board card for `reading:<id>`:
  - First line: the glasses icon, the title (a button that opens the reading panel) and the remove ✕.
  - Second line: a status pill, plus `Groomed <relative>` when present.
  - It has no inline note editor.
  - A missing file shows `reading item not found` in place of the second line.
  - Dragging, keyboard moves and remove are unchanged.
- Palette (`paletteCommands` in `main.ts`):
  - Go to: `Reading list` (keywords `reading`, `links`, `confluence`; `current` when that tab is active).
  - A `Reading` group:
    - `Add a link…`, which focuses the URL bar after switching tab.
    - One item per status, labelled `Show <status>`, which switches to that sub-tab.
  - When the query passes `normaliseUrl`, the group gains `Add <url> to reading list` in first position, which calls the add flow.
- README:
  - Add a `## Reading list` section after `## Kanban`. It covers paste-to-add, sub-tabs, ★ to the Kanban, the side panel, `reading.yaml` (with the example block), the trash on delete, Obsidian (`reading/items` and the `links` field), and a reading groom-file contract next to the ticket one.
  - Update the "Where your data lives" tree with `reading.yaml`, `reading/items/<id>.md` and `reading/groom/<id>.md`.
  - Update the palette paragraph with the Reading group.

- [ ] **Step 1: Implement** the board cards and the palette. Run `npm run typecheck && npm run build`. Expected: success.
- [ ] **Step 2: Write the README.** Then run `grep -niE "<user's real space or option names>" README.md docs/` with the names from `examples/`, to confirm only generic names are present.
- [ ] **Step 3: Run the full check:** `npm test && npm run typecheck`. Expected: every test passes, with no errors.
- [ ] **Step 4: Run the full manual pass** in a browser on the temporary notes folder, from end to end:
  - Paste a link, give it a ticket and a status, and star it.
  - On the Kanban, the card shows and drags.
  - Move it to Done and archive: the item becomes Complete and moves to the Complete sub-tab.
  - ⌘K: "Add https://… to reading list" works, and "Reading list" switches tab.
  - The tab order is Kanban, Scratchpad, Reading, then the views.
  - No console errors.
- [ ] **Step 5: Commit** with `feat(reading): Kanban reading cards, palette commands, README`.
