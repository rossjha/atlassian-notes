# Obsidian-ready Notes Folder (Phase 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every refresh, write one generated, read-only `jira/tickets/KEY.md` per cached ticket, linking it to its parent, its Jira issue links, and the user's note and groom files, so that opening `NOTES_DIR` in Obsidian gives a meaningful graph.

**Architecture:**
- **Fetch:** the Jira client also fetches `issuelinks` and keeps every sprint with its state, as new optional `Ticket` fields.
- **Render and sync:** a new `src/server/ticketFiles.ts` has a pure renderer plus a serialised syncer. The syncer reads the union of all on-disk caches and writes only the files that changed, prunes stale ones, and never touches anything outside `jira/tickets/`.
- **Triggers:** the syncer runs after refreshes and after note or groom file changes.

**Tech Stack:** Node ≥22.18 native TS, `yaml` (existing), node:test.

**Spec:** `docs/superpowers/specs/2026-10-24-obsidian-graph-and-plan-design.md`, section "4a", plus rulings 1, 3 and 7 in "Settled after the builder check".

## Global Constraints

- No new runtime dependencies. Jira stays GET-only. No network traffic except to Jira.
- Tests use temp dirs only. Never touch `~/atlassian-notes-data` or `~/.config/atlassian-notes`. Stop any test server by PID, never `pkill -f`.
- The app fully rewrites only files inside `NOTES_DIR/jira/tickets/`. It never writes `.obsidian/`, and it never modifies note or groom files in this phase.
- Every wikilink the app writes uses the full vault path with an alias: `[[jira/tickets/KEY|KEY]]`, `[[jira/notes/KEY|my note]]`, `[[jira/groom/KEY|groom]]`.
- Only keys passing `isValidKey` (src/server/frontMatter.ts) ever become file names.
- Copy is generic. Use no real names, and use `acme`/`AAA-1`-style examples.
- Match the surrounding code: `.ts` relative imports, erasable TS only, same comment density.
- Run `npm test`, `npm run typecheck` (or the repo's equivalent script) and `npm run build` green before each commit.

## Review Focus

1. **Old caches:** cached tickets written before this change have no `links` or `sprints`. Rendering must treat them as empty, not crash (Task 2 test `renders a ticket cached before links/sprints existed`).
2. **Unsafe keys:** a cache entry with an invalid key (`../evil`, `abc`) is never written, and a non-key file the user put in `jira/tickets/` (e.g. `README.md`) is never deleted (Task 2 tests `skips invalid keys` and `leaves non-ticket files alone`).
3. **Broken notes:** a note whose front matter doesn't parse still gets its ticket file and note link, just without custom properties (Task 2 test `note with broken front matter`).
4. **Odd summaries:** a summary containing `]]`, `|`, `#`, a newline, or YAML-looking text (`key: x`) keeps the front matter valid and the heading on one line (Task 2 test `odd summary text`).
5. **Overlapping syncs:** a refresh and a burst of note edits trigger syncs at the same time. Runs never interleave, and a sync requested mid-run causes exactly one follow-up run (Task 3 test `sync calls are serialised and coalesced`).

---

### Task 1: Fetch issue links and all sprints

**Files:**
- Modify: `src/shared/types.ts` (the `Ticket` interface)
- Modify: `src/server/jira.ts` (`BASE_FIELDS`, `mapTicket`)
- Test: `test/jira.test.ts`, plus a new fixture `test/fixtures/search-links.json`

**Interfaces:**
- Produces (in `src/shared/types.ts`):
  ```ts
  export interface TicketLink { type: string; direction: "inward" | "outward"; key: string }
  export interface TicketSprint { name: string; state: string }
  // on Ticket, both optional because caches written before this change lack them:
  links?: TicketLink[];
  sprints?: TicketSprint[];
  ```
  `type` is the relationship phrase as Jira words it from this ticket's side: `issuelinks[i].type.outward` when `outwardIssue` is present, and `type.inward` when `inwardIssue` is present. `sprints` keeps every entry of the sprint field, in Jira's order, as `{ name, state }`. Entries without a string `name` are dropped, and a missing state becomes `""`. The existing single `sprint` field is unchanged.

- [ ] **Step 1: Write failing tests** in `test/jira.test.ts`.
  - `requests issuelinks`: the `fields` param of a search includes `issuelinks`.
  - `maps issue links and sprints`: uses a fixture issue with
    - `issuelinks: [{ type: { inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "PAY-2" } }, { type: { inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "PAY-3" } }]`
    - the sprint field set to `[{ name: "Sprint 11", state: "closed" }, { name: "Sprint 12", state: "active" }]`
    - and asserts:
  ```ts
  assert.deepEqual(t.links, [
    { type: "blocks", direction: "outward", key: "PAY-2" },
    { type: "is blocked by", direction: "inward", key: "PAY-3" },
  ]);
  assert.deepEqual(t.sprints, [{ name: "Sprint 11", state: "closed" }, { name: "Sprint 12", state: "active" }]);
  assert.equal(t.sprint, "Sprint 12");
  ```
  - `issue without issuelinks or sprints maps to empty arrays`: `links` and `sprints` deep-equal `[]`.
  - `ignores malformed link entries`: an entry with neither `inwardIssue` nor `outwardIssue`, or with a non-string key, is skipped.

- [ ] **Step 2: Run** `node --test test/jira.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Add `"issuelinks"` to `BASE_FIELDS`, and set `links` and `sprints` in `mapTicket` as specified above. The client always sets both, even as empty arrays. They are only optional on the type.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass, including the existing suites.

- [ ] **Step 5: Commit** with the message `feat: fetch Jira issue links and keep every sprint with its state`.

---

### Task 2: Render and sync `jira/tickets/*.md`

**Files:**
- Create: `src/server/ticketFiles.ts`
- Modify: `src/server/cache.ts` (add a method to read every cache file)
- Test: create `test/ticketFiles.test.ts`

**Interfaces:**
- Consumes: `Ticket`, `TicketLink`, `TicketSprint` (Task 1); `CustomColumnDef` from `src/shared/types.ts`; `NotesStore.readNote(key)`, `NotesStore.readGroom(key)` and `atomicWrite(file, content)` from `src/server/notesStore.ts`; `isValidKey` and `stringifyFrontMatter` from `src/server/frontMatter.ts`.
- Produces:
  ```ts
  // src/server/cache.ts
  ViewCache.prototype.allCachedTickets(): Promise<{ tickets: Map<string, Ticket>; cacheFiles: number }>
  // every *.json directly in .cache/views (views and _board); later files win on duplicate keys; cacheFiles = count of files read OK

  // src/server/ticketFiles.ts
  export const TICKETS_DIR = "jira/tickets";
  export const RESERVED_PROPS: readonly string[]; // key, summary, status, statusCategory, type, priority, assignee, sprint, sprints, labels, url, parent, links, tags
  export interface TicketFileContext {
    note: { data: Record<string, unknown>; parseError: string | null } | null; // null = no note file
    hasGroom: boolean;
    custom: Record<string, CustomColumnDef>;
  }
  export function tagSlug(s: string): string;
  export function renderTicketFile(t: Ticket, ctx: TicketFileContext): string;
  export function syncTicketFiles(deps: {
    notesDir: string; cache: ViewCache; notes: NotesStore; getCustom: () => Promise<Record<string, CustomColumnDef>>;
  }): Promise<{ written: number; deleted: number }>;
  ```

**Exact render format.** Front matter goes through `stringifyFrontMatter`, with properties in this order:
- `key`, `summary`, `status`, `statusCategory`, `type`, `priority`, `assignee`
- `sprint`; then `sprints` (as a list of names)
- `labels`, `url`
- `parent`: `"[[jira/tickets/P|P]]"`
- `links`: a deduped list of `"[[jira/tickets/K|K]]"`, in link order
- `tags`
- then custom properties

Properties whose value is `null`, `""` or an empty list are omitted.
- **Tags:** `jira/<tagSlug(type)>`, then for each `select` custom column with a non-empty string value in the note, `<columnId>/<tagSlug(value)>`. Any tag whose slug is empty is skipped.
- **Custom properties:** for every custom column, a string value from the note data is copied under its id, or under `note_<id>` if the id is in `RESERVED_PROPS`. This only happens when the note parsed (`parseError === null`).

`tagSlug` lowercases the string, replaces runs of characters outside `[a-z0-9]` with `-`, and trims leading and trailing `-`.

The body, exactly:
```
<!-- Generated by atlassian-notes from Jira; edits here are overwritten. -->
# KEY · <summary with all whitespace runs collapsed to one space>

- Note: [[jira/notes/KEY|my note]]          ← only if ctx.note !== null
- Groom: [[jira/groom/KEY|groom]]           ← only if ctx.hasGroom
- Parent: [[jira/tickets/P|P]] · <parent summary, whitespace collapsed>   ← only if parent
- <link.type> [[jira/tickets/K|K]]          ← one line per link, in order (not deduped)
```
The list block and its preceding blank line are omitted when there are no lines. The file ends with a single `\n`.

**Sync algorithm:**
- Read `allCachedTickets()`, then skip any key failing `isValidKey`.
- For each remaining key, build the context from `readNote` and `readGroom` and render it. Write with `atomicWrite` only if the file's current content differs, creating `jira/tickets/` if needed.
- Then delete any `jira/tickets/*.md` whose basename is a valid key not in the union. Skip deletion entirely when `cacheFiles === 0`, which protects against a missing or cleared `.cache`.
- Files whose basename isn't a valid key are never touched.

- [ ] **Step 1: Write failing tests** in `test/ticketFiles.test.ts`. Each uses a temp `NOTES_DIR` seeded with cache JSON files written directly, and note or groom files.
  - **`renders front matter, tags and body`:**
    - *Input:* a ticket `AAA-101` with summary "Define step", type "Story", parent `AAA-12` "Epic one", links `[{type:"blocks",direction:"outward",key:"AAA-110"}]`, and sprints `[{name:"Sprint 12",state:"active"}]`. Its note has `category: "Tech debt"`, and `custom = { category: { label: "Category", type: "select", options: {"Tech debt":"amber"} } }`. Groom is present.
    - *Assert* the exact full string, written in the test as a template literal using the format above, including:
      - `tags:` containing `jira/story` and `category/tech-debt`
      - `category: Tech debt`
      - `parent: "[[jira/tickets/AAA-12|AAA-12]]"`
      - the four body lines
  - **`omits note and groom lines when absent`.**
  - **`renders a ticket cached before links/sprints existed`:** the ticket object has no `links` or `sprints` keys, there's no throw, and there are no `links:`/`sprints:` lines.
  - **`reserved custom column id is namespaced`:** a custom column `status` (text) with note value "mine" yields `note_status: mine`, and the Jira `status` stays as-is.
  - **`note with broken front matter`:** the note file content is `"---\nfoo: [\n---\nbody"`. The ticket file still contains the Note line and has no custom properties.
  - **`odd summary text`:** the summary is `"a ]] b | c\n# d key: x"`. Parsing the written file's front matter with `parseFrontMatter` gives `data.summary` equal to the original string, and the heading line is `# AAA-1 · a ]] b | c # d key: x`.
  - **`writes only changed files`:** sync twice. The second run returns `written: 0`, and the file's mtime is unchanged.
  - **`prunes stale ticket files`:** an existing `jira/tickets/AAA-9.md` not in any cache is deleted, giving `deleted: 1`.
  - **`does not prune when there are no cache files`:** with no `.cache/views` dir, `AAA-9.md` survives.
  - **`skips invalid keys`:** a cached ticket with key `"../evil"` writes nothing outside or inside `jira/tickets`.
  - **`leaves non-ticket files alone`:** `jira/tickets/README.md` survives a prune.
  - **`union spans view and board caches`:** a ticket only in `_board.json` gets a file.

- [ ] **Step 2: Run** `node --test test/ticketFiles.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `ViewCache.allCachedTickets()` and `src/server/ticketFiles.ts` to the interfaces and format above.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit** with the message `feat: generate Obsidian-ready jira/tickets/KEY.md hub files from cached tickets`.

---

### Task 3: Run the sync after refreshes and note changes; README

**Files:**
- Modify: `src/server/ticketFiles.ts` (add the serialised syncer)
- Modify: `src/server/refresher.ts`, `src/server/app.ts` (routes `POST /api/views/:id/refresh` and `POST /api/board/refresh`), `src/server/main.ts`
- Modify: `README.md` (new section "Use with Obsidian", placed after "Where your data lives")
- Test: `test/ticketFiles.test.ts`, `test/refresher.test.ts`, and `test/board.test.ts` (where the existing `eventForPath` tests live)

**Interfaces:**
- Consumes: `syncTicketFiles` (Task 2).
- Produces:
  ```ts
  // src/server/ticketFiles.ts
  export interface TicketFileSyncer { sync(): Promise<void>; schedule(): void }
  export function createTicketFileSyncer(run: () => Promise<unknown>, debounceMs = 500): TicketFileSyncer;
  // RefresherDeps gains:  ticketFiles?: TicketFileSyncer
  ```
- **`sync()`** never runs two `run()`s at once. If called while a run is in flight, it resolves after exactly one follow-up run that starts once the current one ends, and several mid-run calls share that one follow-up. Errors are logged with `console.error("ticket file sync failed:", message)` and swallowed. `sync()` always resolves.
- **`schedule()`** debounces calls by `debounceMs`, then calls `sync()`.
- **Wiring:**
  - `Refresher.runAll` awaits `ticketFiles.sync()` once at the very end, after reconcile.
  - The two manual refresh routes call `ticketFiles.schedule()` after their refresh. The refresher exposes the syncer via a `scheduleTicketFiles()` method, so app.ts needs no new dependency.
  - `main.ts` creates the syncer, passes it to the Refresher, and in the `watchNotesDir` callback calls `schedule()` for `note` and `groom` events, and also for `columns` events because custom columns feed tags.
- **Watcher:** `eventForPath("jira/tickets/AAA-1.md")` must return `null`. It already does via the regex; pin it with a test.

- [ ] **Step 1: Write failing tests.**
  - **`sync calls are serialised and coalesced`:**
    - *Setup:* `run` is a fake that records start and end and awaits a manually released promise.
    - *Act:* call `sync()` three times while the first run is in flight.
    - *Assert:* exactly 2 runs total, never overlapping, and all three promises resolve.
  - **`sync swallows errors`:** a throwing `run` resolves and the next `sync()` still runs.
  - **`schedule debounces`:** with `debounceMs = 20`, five `schedule()` calls in a row give one run after about 20ms. Use real timers with a short wait.
  - **`runAll syncs ticket files once at the end`:** in `refresher.test.ts`, with a fake syncer, `sync` is called once and after reconcile. Follow the existing refresher test setup.
  - **`ticket files are ignored by the watcher`:** `eventForPath("jira/tickets/AAA-1.md") === null`.

- [ ] **Step 2: Run** the new tests. Expected: FAIL.

- [ ] **Step 3: Implement** the syncer and the wiring as specified.

- [ ] **Step 4: Write the README section.** It should say, in plain words:
  - Open your notes folder (`NOTES_DIR`, default `~/atlassian-notes-data`) as an Obsidian vault.
  - `jira/tickets/` is generated by the app after each refresh, one file per fetched ticket. Edits there are overwritten, so write in your notes instead.
  - Links use full paths because notes, groom and ticket files share a name. When linking a ticket from your own notes, write `[[jira/tickets/AAA-1|AAA-1]]`.
  - Suggested graph colour groups: `path:jira/tickets`, `path:jira/notes`, `path:jira/groom`.
  - `.cache` is hidden from Obsidian automatically.

  Use generic examples only.

- [ ] **Step 5: Run** `npm test && npm run typecheck && npm run build`. Expected: all green.

- [ ] **Step 6: Manual check in Chrome against a throwaway server.**
  - Start it with a temp `NOTES_DIR` and a temp env file (`ATLASSIAN_NOTES_ENV`), with fake Jira or seeded caches, on a spare port such as 47951. Do not use the user's 4317 or data.
  - Confirm `jira/tickets/*.md` appear after startup and change when a note is created through the UI.
  - Stop the server by PID.

- [ ] **Step 7: Commit** with the message `feat: keep jira/tickets in sync after refreshes and note edits; README: use with Obsidian`.
