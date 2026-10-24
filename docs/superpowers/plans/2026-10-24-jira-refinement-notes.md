# Jira Refinement Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost web app that shows Jira tickets in JQL-driven table views next to the user's private markdown notes and Claude-written groom notes, all stored as files outside the app folder.

**Architecture:** A dependency-light Node server (plain `node:http`, TypeScript run natively by Node) holds the Jira token, makes GET-only calls to Jira Cloud, caches results, reads and writes markdown/YAML under `NOTES_DIR`, and pushes file changes to the browser over Server-Sent Events. The browser UI is plain TypeScript compiled by `tsc` to ES modules with no bundler, styled with Tailwind compiled at build time. Filter and sort logic lives in `src/shared/` and is used by both sides.

**Tech Stack:** Node ≥ 22.18 (native type stripping), TypeScript ^7 (type-check + browser emit only), `yaml`, `marked`, Tailwind v4 via `@tailwindcss/cli`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-24-jira-refinement-notes-design.md`. Read it before starting any task. Spec items are cited as "call N".

## Global Constraints

- Node `>=22.18` (`engines` field). Server code uses erasable TypeScript only: no `enum`, `namespace`, or constructor parameter properties. Relative imports use `.ts` extensions.
- Runtime dependencies: exactly `yaml` and `marked`. Dev dependencies: `typescript`, `@types/node`, `tailwindcss`, `@tailwindcss/cli`. Anything else needs a reason in the task.
- The server listens on `127.0.0.1` only. `PORT` defaults to `4317`.
- The env file is `~/.config/atlassian-notes/.env`, overridable by the `ATLASSIAN_NOTES_ENV` env var. The app never reads `./.env` (call 15).
- Env keys: `JIRA_BASE_URL` (site, e.g. `https://acme.atlassian.net`, used for browse links), `JIRA_CLOUD_ID` (optional; when set the API base becomes `https://api.atlassian.com/ex/jira/<cloudId>`, which scoped API tokens require), `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT`, `NOTES_DIR` (default `~/atlassian-notes-data`), `REFRESH_MINUTES` (default `15`), `PORT` (default `4317`), `OPEN_BROWSER` (default `true`).
- Data layout under `NOTES_DIR`: `views.yaml`, `columns.yaml`, `jira/notes/<KEY>.md`, `jira/groom/<KEY>.md`, `.cache/` (call 2). Nothing personal is written inside the app folder.
- Jira: only HTTP `GET`, and only to the Jira API base (`config.jiraApiBase`). The browser loads nothing from anywhere except the local server. CSP is `default-src 'self'` (call 11).
- Each view is capped at `limit` rows, default `500` (Constraints).
- The app never changes a groom file's body. Outside explicit user edits, it only changes notes and groom files by adding missing `key`/`jira_id` front matter and by renaming on key change (call 17).
- The UI is dark only, dense, and table-first.

## Review Focus

1. **Untrusted ticket keys and field names in URLs** (`../../etc`, `pay-1`, `KEY.md`). Anything that doesn't match `isValidKey`, or isn't a defined custom column id, gets a 400 and never touches disk. Tests: Task 2 (`isValidKey`), Task 8 (route returns 400).
2. **Malformed YAML** in a hand-edited `views.yaml`, `columns.yaml` or note front matter. The app keeps running and shows a readable error naming the file. It never rewrites a file it couldn't parse. Tests: Task 2 (broken front matter refuses field write), Task 3 (bad views.yaml throws `ConfigFileError` with the file name).
3. **A note edited on disk while open in the app** (in a text editor, or by Claude). Saving returns a conflict instead of overwriting. Setting a dropdown value keeps the body byte-for-byte. Tests: Task 2.
4. **Jira failures** (401 bad token, 400 bad JQL, network down). The view shows Jira's own message and keeps the last cached rows. Tests: Task 5 (`JiraError.messages`), Task 7 (refresh failure keeps tickets).
5. **HTML or script inside Jira descriptions, comments or notes.** It renders as text, never as markup. Tests: Task 4 (`renderMarkdownSafe` escapes `<script>` and `javascript:` links).

---

## File Structure

```
package.json, tsconfig.json (server+shared, noEmit), tsconfig.web.json (web+shared → public/js)
.env.example, .gitignore, README.md
examples/views.example.yaml, examples/columns.example.yaml
scripts/setup.ts, scripts/pack.ts
src/shared/types.ts        Ticket, IssueDetail, View, ColumnSetting, Filters, ColumnsConfig, Row, NoteFile, GroomFile, LiveEvent
src/shared/rowOps.ts       cellValue, applyFilters, sortRows (used by server tests + browser)
src/server/config.ts       env file location + parsing → Config
src/server/frontMatter.ts  parse/stringify markdown front matter
src/server/notesStore.ts   notes + groom files: read, write, field set, identity, rename, isValidKey
src/server/configFiles.ts  ensureDataDir, load/save views.yaml, load columns.yaml, validation
src/server/markdown.ts     adfToMarkdown, renderMarkdownSafe
src/server/jira.ts         GET-only Jira client + issue mapping
src/server/rows.ts         buildRow (ticket + note + groom → Row)
src/server/copyText.ts     clipboard text builders
src/server/cache.ts        ViewCache (.cache/views/<id>.json)
src/server/reconcile.ts    key-change renames + orphan detection
src/server/refresher.ts    refresh one/all views, background interval
src/server/watcher.ts      fs.watch NOTES_DIR → LiveEvent
src/server/app.ts          HTTP routes, SSE, security headers, static files
src/server/main.ts         wiring + listen + open browser
src/web/styles.css, public/index.html
src/web/main.ts, api.ts, dom.ts, live.ts, table.ts, cells.ts, filterBar.ts, viewEditor.ts, drawer.ts
test/*.test.ts, test/fixtures/*.json
```

---

### Task 1: Project scaffold and config loading

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.web.json`, `.env.example`, `src/server/config.ts`, `test/config.test.ts`
- Modify: `.gitignore` (add `public/js/`, `public/app.css`), and in the spec change `Status: draft for approval` to `Status: approved`

**Interfaces:**
- Produces:
  - `interface Config { jiraBaseUrl: string; jiraApiBase: string; jiraEmail: string; jiraApiToken: string; defaultProject: string; notesDir: string; refreshMinutes: number; port: number; openBrowser: boolean }`
  - `envFilePath(env: Record<string,string|undefined>, home: string): string`
  - `parseEnvFile(text: string): Record<string,string>`
  - `loadConfig(env: Record<string,string|undefined>, home: string, readFile?: (p: string) => string): Config`. On failure it throws `ConfigError` (`.missing: string[]`, message lists the keys and the env file path).

`package.json` scripts:
- `"build": "tsc -p tsconfig.web.json && tailwindcss -i src/web/styles.css -o public/app.css --minify"`
- `"start": "npm run build && node src/server/main.ts"`
- `"test": "node --test \"test/**/*.test.ts\""`
- `"typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.web.json --noEmit"`
- `"setup": "node scripts/setup.ts"`, `"pack": "node scripts/pack.ts"`

`tsconfig.json`:
- `noEmit`, `strict`, `module`/`moduleResolution` `nodenext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`
- includes `src/server`, `src/shared`, `scripts`, `test`

`tsconfig.web.json`:
- `rootDir: src`, `outDir: public/js`, `lib: ["dom","es2023"]`, `module: esnext`, `rewriteRelativeImportExtensions: true`
- includes `src/web`, `src/shared`

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`:
  - `envFilePath({}, "/h")` returns `"/h/.config/atlassian-notes/.env"`.
  - `envFilePath({ATLASSIAN_NOTES_ENV: "/x/e"}, "/h")` returns `"/x/e"`.
  - `parseEnvFile` handles comments, blank lines, `KEY="quoted value"`, `KEY='single'`, and `=` inside values (`JIRA_API_TOKEN=ab=cd` gives `"ab=cd"`).
  - With a fake `readFile` returning all required keys, the defaults are `notesDir === "/h/atlassian-notes-data"`, `refreshMinutes === 15`, `port === 4317` and `openBrowser === true`. `NOTES_DIR=~/n` expands to `"/h/n"`. A trailing slash on `JIRA_BASE_URL` is stripped. Without `JIRA_CLOUD_ID`, `jiraApiBase === jiraBaseUrl`. With `JIRA_CLOUD_ID=abc`, it is `"https://api.atlassian.com/ex/jira/abc"`.
  - Missing `JIRA_API_TOKEN` and `JIRA_EMAIL` throws `ConfigError` with `missing` deep-equal to `["JIRA_EMAIL","JIRA_API_TOKEN"]`.
  - `readFile` throwing ENOENT throws a `ConfigError` whose message contains the path and `npm run setup`.
  - Spy on `readFile` and assert it is never called with a path ending in `atlassian-notes/.env` relative to `process.cwd()`. The only path read is `envFilePath(...)`.
- [ ] **Step 2: Run** `npm install && npm test`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/server/config.ts`. Real process env vars override file values, so `{...fileValues, ...env}` for the known keys.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Also run `npm run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: scaffold project and config loading"`

---

### Task 2: Front matter and notes store

**Files:**
- Create: `src/shared/types.ts` (the `NoteFile`/`GroomFile`/`GroomSummary` parts; later tasks extend it), `src/server/frontMatter.ts`, `src/server/notesStore.ts`, `test/frontMatter.test.ts`, `test/notesStore.test.ts`

**Interfaces:**
- Produces:
  - `interface ParsedDoc { data: Record<string, unknown>; body: string; hasFrontMatter: boolean; error: string | null }`
  - `parseFrontMatter(text: string): ParsedDoc`. Front matter is a leading `---\n…\n---\n` block. On a YAML error it returns `data: {}`, `body: text` (the whole thing) and `error` set.
  - `stringifyFrontMatter(data: Record<string, unknown>, body: string): string`. With empty `data` it returns `body` unchanged.
  - `isValidKey(key: string): boolean` matches `/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/`
  - `interface NoteFile { key: string; data: Record<string, unknown>; body: string; mtimeMs: number; parseError: string | null }`
  - `interface GroomSummary { readiness: string | null; summary: string; groomedAt: string | null }`
  - `interface GroomFile extends NoteFile { summary: GroomSummary }`. `groomedAt` is `groomed_at` from front matter, or else the ISO form of `mtimeMs`. `summary` is front matter `summary`, or else the first non-empty body line with any leading `#` removed.
  - `type WriteResult = { ok: true; mtimeMs: number } | { ok: false; conflict: NoteFile | null; reason: "conflict" | "parse-error" }`
  - `class NotesStore`, built as `new NotesStore(notesDir: string)`, with:
    - `readNote(key): Promise<NoteFile|null>`
    - `readGroom(key): Promise<GroomFile|null>`
    - `writeNoteBody(key, body, opts: { baseMtimeMs: number|null; jiraId?: string; force?: boolean }): Promise<WriteResult>`
    - `setNoteField(key, field, value: string|null, jiraId?: string): Promise<WriteResult>`
    - `ensureIdentity(key, jiraId): Promise<void>`
    - `renameKey(oldKey, newKey): Promise<"renamed"|"target-exists"|"missing">`
    - `listAll(): Promise<{ notes: NoteFile[]; grooms: GroomFile[] }>`
    - `notePath(key)` and `groomPath(key)`, both returning absolute paths

Every public method throws `InvalidKeyError` when `!isValidKey(key)`. Writes are atomic: write to `<file>.tmp-<pid>` in the same directory, then `rename`. New notes get `key` and, when known, `jira_id` (a string) in front matter.

- [ ] **Step 1: Write failing tests**, using a temp dir from `fs.mkdtemp(os.tmpdir())` per test.
  - frontMatter:
    - round trip `---\nkey: A-1\n---\nhello\n` gives `data.key === "A-1"` and `body === "hello\n"`
    - text without front matter gives `hasFrontMatter false` and the body equal to the text
    - `---\nkey: [unclosed\n---\nx` sets `error` non-null and `body` to the full text
    - `stringifyFrontMatter({}, "b")` returns `"b"`
  - `isValidKey`:
    - true: `"PAY-412"`, `"AB_2-1"`
    - false: `"pay-1"`, `"../X-1"`, `"PAY-0"`, `"PAY-1.md"`, `"PAY-1/.."`, `""`
  - `writeNoteBody("PAY-1", "hi", {baseMtimeMs: null, jiraId: "100"})` creates `jira/notes/PAY-1.md`, with data `{key: "PAY-1", jira_id: "100"}` and body `"hi"`.
  - Conflict: write the note, change the file externally (with an mtime bump via `fs.utimes` +5s), then save with the old `baseMtimeMs`. Expect `{ok: false, reason: "conflict"}` with `conflict.body` holding the external text, and the file left unchanged. Saving again with `force: true` succeeds.
  - `baseMtimeMs: null` when the file already exists gives a conflict.
  - The `setNoteField` body is preserved byte-for-byte. Write the body `"line1\n\n- [ ] x\n  trailing  \n"`, set `category` to `"Tech debt"`, re-read: the body is identical. `setNoteField(key, "category", null)` removes the key.
  - `setNoteField` on a file with broken front matter returns `{ok: false, reason: "parse-error"}` and leaves the file unchanged.
  - Any method with `"../X-1"` rejects with `InvalidKeyError`, and nothing is created outside `notesDir`.
  - `readGroom`:
    - with front matter `readiness`/`summary`/`groomed_at`, those values come back
    - with no front matter and body `"\n# Verdict: ready\nmore"`, it returns `summary === "Verdict: ready"`, `readiness === null`, and `groomedAt` is the mtime as ISO
  - `ensureIdentity("PAY-1", "100")` on a groom file with no front matter adds `key`/`jira_id`, and the body is byte-identical after. It doesn't change a file whose `key`/`jira_id` already match (the mtime is unchanged). It skips files with parse errors.
  - `renameKey("PAY-1", "NEW-5")` moves both notes and groom files and sets `key: NEW-5`. If the target exists, it returns `"target-exists"` and moves nothing.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `frontMatter.ts` (with the `yaml` package) and `notesStore.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: markdown front matter and notes store"` (add new files first).

---

### Task 3: Views/columns config files and first-run setup

**Files:**
- Create: `src/server/configFiles.ts`, `examples/views.example.yaml`, `examples/columns.example.yaml`, `test/configFiles.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces (in `types.ts`):
  - `type BuiltinColumnId = "key"|"summary"|"status"|"type"|"priority"|"assignee"|"reporter"|"storyPoints"|"parent"|"labels"|"sprint"|"updated"|"note"|"groom"`
  - `BUILTIN_COLUMNS: { id: BuiltinColumnId; label: string }[]` (exported const)
  - `interface ColumnSetting { id: string; hidden?: boolean; display?: "truncate"|"expand" }`
  - `type FilterValue = { op: "oneOf"; values: string[] } | { op: "empty" } | { op: "notEmpty" } | { op: "contains"; text: string }`
  - `type Filters = Record<string, FilterValue>` (keyed by custom column id)
  - `interface View { id: string; name: string; jql: string; limit: number; columns: ColumnSetting[]; filters: Filters }`
  - `type CustomColumnDef = { label: string; type: "select"; options: Record<string, string> } | { label: string; type: "text" }`. Option values are colours like `#5b8def`.
  - `interface ColumnsConfig { jiraFields: { storyPoints: string|null; sprint: string; acceptanceCriteria: string|null }; custom: Record<string, CustomColumnDef>; groomPrompt: string }`
- Produces (in `configFiles.ts`):
  - `ensureDataDir(notesDir: string, projectKey: string, examplesDir: string): Promise<void>`. Creates `jira/notes`, `jira/groom` and `.cache/views`. Copies `views.example.yaml` to `views.yaml` with every `{{PROJECT}}` replaced, but only if `views.yaml` is missing. Copies `columns.example.yaml` the same way. It never overwrites.
  - `loadColumns(notesDir): Promise<ColumnsConfig>`
  - `loadViews(notesDir, columns: ColumnsConfig): Promise<View[]>`
  - `saveViews(notesDir, views: View[]): Promise<void>` (atomic write)
  - `class ConfigFileError extends Error { file: string }`

Defaults when absent:
- `jiraFields.sprint`: `"customfield_10020"`
- `storyPoints`: `null`
- `acceptanceCriteria`: `null`
- `limit`: `500`
- `filters`: `{}`
- `groomPrompt`: `"Run groom-work-item on {key} ({url}). Save the result to {groomPath} with front matter: readiness, summary, groomed_at (ISO)."`

Validation:
- view `id` values are unique and match `/^[a-z0-9-]+$/`
- custom column ids don't clash with `BuiltinColumnId`
- column ids in a view are builtin or custom (unknown ones are dropped with a `console.warn`)
- filter keys must be custom column ids

Examples:
- the three views from call 16, with `{{PROJECT}}` substituted, ids `current`, `next` and `backlog`
- columns `key, summary, status, storyPoints, note (truncate), groom (truncate), category`
- `columns.example.yaml` is the call 8 example, plus `sprint: customfield_10020`, plus a commented `acceptanceCriteria:` line

- [ ] **Step 1: Write failing tests:**
  - `ensureDataDir(tmp, "PAY", "examples")` writes a `views.yaml` containing `project = PAY AND sprint in openSprints()` and no `{{PROJECT}}`. A second call after editing `views.yaml` leaves the edit in place.
  - `loadViews` on the generated files returns 3 views, with `limit` 500 and `filters` `{}`.
  - `loadViews` with `views: [ {id: x` (broken YAML) rejects with `ConfigFileError` where `file` ends in `views.yaml`.
  - Duplicate view ids reject with `ConfigFileError`.
  - A custom column named `status` rejects with `ConfigFileError` on `columns.yaml`.
  - The `saveViews` → `loadViews` round trip deep-equals the input.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: views/columns config and first-run data dir`.

---

### Task 4: ADF to markdown and safe rendering

**Files:**
- Create: `src/server/markdown.ts`, `test/markdown.test.ts`

**Interfaces:**
- Produces:
  - `adfToMarkdown(node: unknown): string`. `null`/`undefined` gives `""`. A plain string input is returned as-is (some custom fields are plain text).
  - `renderMarkdownSafe(md: string): string` (HTML)

Node mapping:

| ADF node | Markdown |
|---|---|
| `doc`, `paragraph` | text blocks separated by a blank line |
| `heading` (`attrs.level`) | `#`×level |
| `bulletList` / `orderedList` / `listItem` | two-space indent per nesting level |
| `codeBlock` | fenced block with `attrs.language` |
| `blockquote` | `> ` |
| `rule` | `---` |
| `hardBreak` | newline |
| `mention` | `@` + `attrs.text` without a leading `@` |
| `emoji` | `attrs.text` |
| `inlineCard` | its `attrs.url` |
| `text` with `strong` / `em` / `code` / `link` marks | `**…**` / `_…_` / `` `…` `` / `[t](href)` |
| `table` | rows as `| a | b |` lines |
| any other node | the concatenated text of its children |

`renderMarkdownSafe` uses `marked` and overrides the `html` renderer to emit escaped text. Links with protocols other than `http:`, `https:` and `mailto:` render as plain text. The output contains no raw HTML from the input.

- [ ] **Step 1: Write failing tests:**
  - heading level 2 gives `"## Title"`
  - a nested bullet list gives `"- a\n  - b"`
  - a code block with language `ts` gives a fence starting `` ```ts ``
  - a link mark gives `"[site](https://x.y)"`
  - a mention `{text: "@Sam"}` gives `"@Sam"`
  - an unknown node type `"panel"` containing a paragraph `"warn"` gives output containing `"warn"`
  - `renderMarkdownSafe("<script>alert(1)</script>")` contains `&lt;script&gt;` and not `<script`
  - `renderMarkdownSafe("[x](javascript:alert(1))")` contains no `href="javascript`
  - `renderMarkdownSafe("- [ ] task")` renders a list item
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: ADF to markdown and safe markdown rendering`.

---

### Task 5: GET-only Jira client

**Files:**
- Create: `src/server/jira.ts`, `test/jira.test.ts`, `test/fixtures/search-page1.json`, `test/fixtures/search-page2.json`, `test/fixtures/issue-detail.json`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: `ColumnsConfig["jiraFields"]` (Task 3), `adfToMarkdown` (Task 4)
- Produces (in `types.ts`):
  - `interface Ticket { id: string; key: string; url: string; summary: string; status: string; statusCategory: string; type: string; priority: string|null; assignee: string|null; reporter: string|null; storyPoints: number|null; parent: { key: string; summary: string }|null; labels: string[]; sprint: string|null; updated: string }`
  - `interface IssueDetail { ticket: Ticket; descriptionMd: string; acceptanceCriteriaMd: string|null; comments: { author: string; created: string; bodyMd: string }[] }`
- Produces (in `jira.ts`):
  - `interface JiraClient { search(jql: string, limit: number): Promise<Ticket[]>; getIssueDetail(idOrKey: string): Promise<IssueDetail>; getIssueBrief(idOrKey: string): Promise<{ id: string; key: string } | null> }`
  - `createJiraClient(opts: { apiBase: string; siteUrl: string; email: string; token: string; fields: ColumnsConfig["jiraFields"] }, fetchFn?: typeof fetch): JiraClient`
  - `class JiraError extends Error { status: number; messages: string[] }`

Behaviour:
- All requests go through one private `get(path, params)`. It uses `method: "GET"`, `Authorization: Basic base64(email:token)` and `Accept: application/json`, and builds the URL from `apiBase`. There is no other request path.
- `search`:
  - calls `GET /rest/api/3/search/jql` with `jql`, `maxResults=min(100, remaining)` and `fields`
  - `fields` is `summary,status,issuetype,priority,assignee,reporter,parent,labels,updated`, plus the mapped story points and sprint fields
  - follows `nextPageToken` until `isLast` or `limit` is reached
- `getIssueDetail`: `GET /rest/api/3/issue/{idOrKey}` with those fields plus `description,comment` and the acceptance criteria field when mapped.
- `getIssueBrief`: `GET /rest/api/3/issue/{idOrKey}?fields=summary`. A 404 returns `null`.
- Non-2xx: throw `JiraError`. `messages` comes from the body's `errorMessages` plus the values of `errors`, or `[status text]` if the body isn't JSON. A `fetch` rejection becomes `JiraError` with status `0` and the message `"Could not reach Jira: <cause>"`.
- Mapping:
  - `url` is `${siteUrl}/browse/${key}`
  - `sprint` is the name of the sprint with `state === "active"`, else the last sprint's name, else `null`
  - `storyPoints` is `null` when the field is unmapped or not a number

- [ ] **Step 1: Write failing tests** with a fake `fetchFn` that records each call and returns fixtures:
  - Two pages (page1 has `nextPageToken: "t2"`, page2 has `isLast: true`) give a combined ticket list. The second call's URL has `nextPageToken=t2`.
  - `limit: 3` with 5 available returns 3 tickets, and the first call has `maxResults=3`.
  - Every recorded call has `method === "GET"` and a URL starting with `apiBase`. With `apiBase` set to the `api.atlassian.com/ex/jira/…` form, the ticket `url` still uses `siteUrl`.
  - The mapped ticket from the fixture has the expected `status`, `storyPoints` (from `customfield_10016`), `sprint` (the active one) and `parent.key`.
  - A 400 with `{"errorMessages":["Error in the JQL Query: ..."]}` rejects with `JiraError` where `status === 400` and `messages[0]` starts with `"Error in the JQL"`.
  - A 401 with a non-JSON body rejects with `JiraError` where `status === 401`.
  - `fetchFn` rejecting gives `JiraError` with status 0 and a message starting `"Could not reach Jira"`.
  - `getIssueBrief` with a 404 returns `null`.
  - `getIssueDetail` gives `descriptionMd` converted from the fixture's ADF, and a comment with author `displayName`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: GET-only Jira Cloud client`.

---

### Task 6: Rows, filtering, sorting, copy text

**Files:**
- Create: `src/server/rows.ts`, `src/shared/rowOps.ts`, `src/server/copyText.ts`, `test/rows.test.ts`, `test/rowOps.test.ts`, `test/copyText.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces (`types.ts`): `interface Row { ticket: Ticket; note: { body: string; mtimeMs: number } | null; groom: GroomSummary | null; custom: Record<string, string>; flags: { jiraNewerThanNote: boolean; jiraNewerThanGroom: boolean } }`
- Produces:
  - `buildRow(ticket: Ticket, note: NoteFile|null, groom: GroomFile|null, customIds: string[]): Row`
    - `custom[id]` is `String(note.data[id])` when present and not null; otherwise the key is absent
    - `jiraNewerThanNote` is `Date.parse(ticket.updated) > note.mtimeMs`
    - `jiraNewerThanGroom` compares against `Date.parse(groom.groomedAt)`
  - `cellValue(row: Row, columnId: string): string | number | null`
    - `storyPoints` is a number
    - `labels` are joined with `", "`
    - `parent` is the parent key
    - `note` is the note body
    - `groom` is `readiness + " " + summary`
    - custom ids come from `row.custom`
  - `applyFilters(rows: Row[], filters: Filters): Row[]`. Filters combine with AND. `oneOf` is exact membership. `empty` means missing or `""`. `contains` is case-insensitive on the custom value.
  - `sortRows(rows: Row[], columnId: string, dir: "asc"|"desc"): Row[]`. Returns a new array. Nulls go last in both directions. Numbers compare numerically. `key` sorts naturally by project and then number (`PAY-9` before `PAY-10`). Other strings use `localeCompare` with `sensitivity: "base"`.
  - `ticketMarkdown(d: IssueDetail): string`
  - `bothMarkdown(d: IssueDetail, note: NoteFile|null, groom: GroomFile|null): string`
  - `groomPrompt(template: string, vars: { key: string; url: string; groomPath: string }): string`

Exact copy formats (call 12):

`ticketMarkdown`:
```
# {key}: {summary}
{url}

- Status: {status}
- Type: {type}
- Story points: {storyPoints or "–"}

## Description
{descriptionMd or "_None_"}

## Acceptance criteria        ← only when acceptanceCriteriaMd is non-null
{acceptanceCriteriaMd}

## Comments                   ← only when there are comments
### {author} — {created as YYYY-MM-DD}
{bodyMd}
```

`bothMarkdown` is `ticketMarkdown`, then `\n\n# My notes\n{note body or "_None_"}`, then `\n\n# Groom output\n{groom body or "_None_"}`.

`groomPrompt` replaces `{key}`, `{url}` and `{groomPath}`.

- [ ] **Step 1: Write failing tests:**
  - flags are true when `updated` is after the note mtime
  - `custom.category` is read from note front matter
  - `oneOf` keeps only the matching rows
  - `empty` keeps rows with no value
  - `contains` is case-insensitive
  - two filters combine with AND
  - sorting `["PAY-10","PAY-9","PAY-100"]` by key ascending gives `PAY-9, PAY-10, PAY-100`
  - a null `storyPoints` sorts last in both directions
  - `ticketMarkdown` for a fixture with no comments has no `## Comments` heading, and its first line is `# PAY-412: Retry failed card captures`
  - `groomPrompt` with the default template contains the key and the groom path
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `rowOps.ts` imports only from `./types.ts`, because it must compile for the browser.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: rows, local filter/sort, copy text`.

---

### Task 7: Cache, refresher, reconcile

**Files:**
- Create: `src/server/cache.ts`, `src/server/reconcile.ts`, `src/server/refresher.ts`, `test/refresher.test.ts`, `test/reconcile.test.ts`

**Interfaces:**
- Consumes: `JiraClient` (Task 5), `NotesStore` (Task 2), `View` (Task 3)
- Produces:
  - `interface CachedView { fetchedAt: string | null; tickets: Ticket[]; error: string | null }`
  - `class ViewCache`, built as `new ViewCache(notesDir)`:
    - `read(viewId): Promise<CachedView>` returns `{fetchedAt: null, tickets: [], error: null}` when the cache is missing or corrupt
    - `write(viewId, v): Promise<void>` writes `.cache/views/<viewId>.json` atomically
    - `allTickets(viewIds: string[]): Promise<Map<string, Ticket>>` (keyed by ticket key)
  - `reconcile(deps: { jira: JiraClient; notes: NotesStore; seen: Map<string, Ticket>; statePath: string; now: Date }): Promise<{ renamed: [string, string][]; orphans: string[] }>`
  - `class Refresher`, built as `new Refresher(deps: { jira: JiraClient; cache: ViewCache; notes: NotesStore; getViews: () => Promise<View[]>; onChange: (e: LiveEvent) => void; statePath: string; now?: () => Date })`, with:
    - `refreshView(view: View): Promise<CachedView>`
    - `refreshAll(): Promise<void>`
    - `start(minutes: number): void`
    - `stop(): void`
    - `orphans(): string[]`
  - `LiveEvent` in `types.ts`: `{ type: "rows"; viewId: string } | { type: "note" | "groom"; key: string } | { type: "views" | "columns" } | { type: "orphans" }`

Refresh behaviour:
- **Success:** writes `{fetchedAt: now ISO, tickets, error: null}`. Calls `notes.ensureIdentity(t.key, t.id)` for each ticket that has a note or groom file. Emits `{type:"rows", viewId}`.
- **Failure (`JiraError`):** writes the previous tickets and `fetchedAt` with `error: messages.join("; ")`, then emits `rows`.
- **`refreshAll`:** refreshes views one at a time, then runs `reconcile` with `seen` covering all cached tickets, then emits `orphans` if the set changed. An overlapping `refreshAll` call returns the in-flight promise.

Reconcile algorithm (call 17). For each note or groom key not in `seen`:
1. If some ticket in `seen` has `id === file's jira_id`, call `renameKey(key, ticket.key)`.
2. Otherwise, if `statePath` has a check for this key less than 24h old, reuse its orphan status.
3. Otherwise, call `getIssueBrief(jira_id ?? key)`:
   - `null` means orphan
   - a different key means rename
   - the same key means not an orphan
4. Record the check in the state JSON `{ checked: Record<key, { at: ISO; orphan: boolean }> }`. A `JiraError` with status ≠ 404 skips that key this round, without changing its state.

The app never deletes a file.

- [ ] **Step 1: Write failing tests** with a fake `JiraClient` and a temp dir:
  - a successful refresh writes the cache, and `ensureIdentity` adds `jira_id` to an existing note for a returned ticket
  - a refresh where `search` throws `JiraError(400, ["bad jql"])` keeps the earlier tickets, sets `error === "bad jql"`, and keeps `fetchedAt` unchanged
  - `onChange` receives `{type: "rows", viewId: "current"}` in both cases
  - reconcile: a note `PAY-1` with `jira_id: "100"` and a seen ticket `{id: "100", key: "NEW-5"}` gives `renamed` `[["PAY-1","NEW-5"]]`, and no `getIssueBrief` call is made
  - reconcile: an unseen note where `getIssueBrief` returns `null` makes it an orphan, and a second run within 24h makes no API call
  - reconcile: an unseen note where `getIssueBrief` returns the same key is not an orphan
  - after any reconcile, no file has been deleted (the file count is unchanged)
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: view cache, background refresh, key reconcile`.

---

### Task 8: HTTP server, API, live events

**Files:**
- Create: `src/server/watcher.ts`, `src/server/app.ts`, `src/server/main.ts`, `test/app.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `watchNotesDir(notesDir: string, onEvent: (e: LiveEvent) => void): () => void`
    - uses `fs.watch(notesDir, {recursive: true})`, debounced per path by 150 ms
    - ignores `.cache/` and `*.tmp-*`
    - maps `jira/notes/K.md` to `{type:"note",key}`, `jira/groom/K.md` to `{type:"groom",key}`, `views.yaml` to `views`, and `columns.yaml` to `columns`
  - `createApp(deps: { config: Config; jira: JiraClient; notes: NotesStore; cache: ViewCache; refresher: Refresher; publicDir: string }): { server: http.Server; broadcast: (e: LiveEvent) => void }`
  - `main.ts`:
    1. `loadConfig` (prints `ConfigError` message and exits 1)
    2. `ensureDataDir`
    3. build the dependencies
    4. `listen(port, "127.0.0.1")`
    5. `refresher.start(refreshMinutes)` and an immediate `refreshAll()`
    6. watcher → broadcast
    7. if `openBrowser`, run `open` (darwin), `xdg-open` (linux) or `cmd /c start` (win32) on `http://localhost:<port>/`

Routes. All responses are JSON unless noted. `:key` must pass `isValidKey`, otherwise the route returns 400 `{error}`.

| Method & path | Behaviour |
|---|---|
| `GET /api/config` | `{ views: View[], columns: ColumnsConfig, jiraBaseUrl, error: string\|null }`. A config-file error goes into `error` and returns 200 so the UI can show it. |
| `PUT /api/views` | body `{views: View[]}` → validate + `saveViews`, return 204 |
| `GET /api/views/:id/rows` | `{ rows: Row[], fetchedAt, error }`, built from the cache plus `notes.listAll()` |
| `POST /api/views/:id/refresh` | `refresher.refreshView`, then the same as rows |
| `GET /api/tickets/:key` | `{ detail: IssueDetail, html: { description, acceptanceCriteria, comments: string[] }, note: NoteFile\|null, noteHtml, groom: GroomFile\|null, groomHtml, groomPath }`. Rendered with `renderMarkdownSafe`. A Jira error gives 502 `{error}`. |
| `PUT /api/notes/:key` | body `{body, baseMtimeMs, force?}`. `jiraId` comes from the cached ticket. `ok` → 200 `{mtimeMs}`, `conflict` → 409 `{current: NoteFile}`, `parse-error` → 422 `{error}` |
| `PUT /api/notes/:key/fields/:field` | `field` must be a custom column id, else 400. body `{value: string\|null}`. Same responses as above. |
| `GET /api/tickets/:key/copy/:kind` | kind `ticket\|notes\|both\|prompt` → `text/plain` |
| `GET /api/orphans` | `{ orphans: string[] }` |
| `GET /api/events` | SSE: `data: <LiveEvent JSON>\n\n` plus a `: ping` comment every 25 s |
| `GET /*` | static files from `publicDir` (`/` → `index.html`). Paths are resolved and must stay inside `publicDir`. The content type comes from the extension. |

Security on every request:
- **Host:** must be `localhost:<port>` or `127.0.0.1:<port>`, otherwise 421.
- **Non-GET requests:** need `Content-Type: application/json`, otherwise 415. If an `Origin` header is present, it must be `http://localhost:<port>` or `http://127.0.0.1:<port>`, otherwise 403.
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-store` on `/api/*`

- [ ] **Step 1: Write failing tests.** Start `createApp` on port 0 with a fake Jira client and a temp `NOTES_DIR` (via `ensureDataDir`), and use `fetch`. Send the `Host` header as `localhost:<port>`.
  - `GET /api/config` returns the 3 example views
  - after `POST /api/views/current/refresh`, `GET /api/views/current/rows` returns the fake tickets
  - `PUT /api/notes/PAY-1` creates the file, and a second save with the old `baseMtimeMs` after an external edit returns 409
  - `PUT /api/notes/..%2Fx/fields/category` returns 400
  - `PUT /api/notes/PAY-1/fields/status` returns 400 (not a custom column)
  - a `PUT` with `Origin: https://evil.example` returns 403
  - a `PUT` with `Content-Type: text/plain` returns 415
  - `Host: evil.example:1234` returns 421
  - `GET /../package.json` doesn't serve outside `publicDir` (404)
  - every response has the CSP header
  - `GET /api/tickets/PAY-1/copy/prompt` contains `jira/groom/PAY-1.md`
  - corrupting `views.yaml` makes `GET /api/config` return 200 with `error` naming `views.yaml`
  - SSE: connect to `/api/events`, write `jira/groom/PAY-1.md`, and receive `{"type":"groom","key":"PAY-1"}` within 2 s
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: local HTTP API, SSE, security headers`.

---

### Task 9: UI shell, tabs and table

**Files:**
- Create: `public/index.html`, `src/web/styles.css`, `src/web/dom.ts`, `src/web/api.ts`, `src/web/live.ts`, `src/web/main.ts`, `src/web/table.ts`, `src/web/cells.ts`

**Interfaces:**
- Consumes: the Task 8 routes, `rowOps.ts`, `types.ts`
- Produces:
  - `h(tag: string, attrs?: Record<string, string|boolean|((e: Event) => void)>, ...children: (Node|string|null)[]): HTMLElement`. Sets text with `textContent` only. `setHtml(el, trustedServerHtml)` is the one place `innerHTML` is used, and only for `*Html` fields from the server.
  - `api` object: one typed function per route, for example `api.rows(viewId): Promise<{rows: Row[]; fetchedAt: string|null; error: string|null}>`
  - `connectLive(onEvent: (e: LiveEvent) => void): void` (an `EventSource` that reconnects by itself)
  - `renderTable(container: HTMLElement, view: View, rows: Row[], columns: ColumnsConfig, handlers: TableHandlers): void`
  - `interface TableHandlers { onOpen(key: string): void; onSort(columnId: string): void; onNoteSaved(): void }`
  - `renderCell(row: Row, setting: ColumnSetting, columns: ColumnsConfig): HTMLElement`

Behaviour:
- **Tabs:** one per view, and the active tab is remembered in `localStorage` (wrap it in try/catch).
- **View header:** shows the JQL in monospace, "Last refreshed {relative time}", a Refresh button (`POST refresh`), and Jira's `error` in a red bar above the table while keeping the rows.
- **Table:** shows the visible columns in `view.columns` order, plus a header click to sort (an indicator, held in memory).
- **Live events:**
  - `rows` for the active view refetches it
  - `note` and `groom` refetch the active view's rows
  - `views` and `columns` refetch the config
- **Cells:**
  - the key is monospace and links to the drill-in
  - status is a pill
  - `note` follows `display` (`truncate` is a single line with ellipsis, `expand` is pre-wrapped)
  - `groom` is a tinted box showing readiness, summary and age ("2d ago")
  - an orange dot means `jiraNewerThanNote` or `jiraNewerThanGroom`, with a title attribute explaining which
  - custom `select` columns are a pill with the option colour applied via `el.style.setProperty`, because CSP blocks style attributes in markup
  - an ungroomed `groom` cell shows a "copy groom prompt" link
- **Style:** dark slate background, dense rows, matching the mockup direction (spec "Left to the builder").

`styles.css`:
- `@import "tailwindcss"; @source "../web"; @source "../../public/index.html";`
- a handful of `@layer components` classes (`.pill`, `.note-box`, `.groom-box`)

- [ ] **Step 1: Build:** `npm run build`. Expected: `public/js/web/main.js` and `public/app.css` exist, and `tsc` reports no errors.
- [ ] **Step 2: Manual check** against the user's personal Jira project. Set up `~/.config/atlassian-notes/.env` by hand for now. Run `npm start`, then:
  - the browser opens with 3 tabs
  - Refresh loads tickets
  - a deliberately broken JQL in `views.yaml` shows Jira's error in the red bar
  - writing `jira/groom/<KEY>.md` by hand updates the row with no reload
  - Firefox devtools Network shows only `localhost` requests, and the console shows no CSP violations
- [ ] **Step 3: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `feat: UI shell, tabs, live table`.

---

### Task 10: Editing notes and custom columns in the table

**Files:**
- Modify: `src/web/cells.ts`, `src/web/table.ts`
- Create: `src/web/editors.ts`

**Interfaces:**
- Consumes: `api.saveNote(key, body, baseMtimeMs, force?)` and `api.setField(key, field, value)` (add these to `api.ts`)
- Produces:
  - `editNote(cell: HTMLElement, row: Row, onDone: () => void): void`
  - `editCustom(cell: HTMLElement, row: Row, colId: string, def: CustomColumnDef, onDone: () => void): void`

Behaviour (call 14):
- **Note cell:** clicking it replaces it with a textarea. It saves on blur or Cmd/Ctrl+Enter and cancels on Esc.
  - A 409 shows an inline warning, "Changed on disk since you opened it", with **Reload theirs** and **Overwrite** (`force: true`) buttons, and keeps the user's text in the textarea.
  - A 422 shows the parse error.
- **Select column:** clicking it opens a native `<select>` of the options plus "— none —", and saves on change.
- **Text column:** an inline input that saves on blur or Enter.
- **Display toggle:** a small toggle in each `note`/`groom` column header flips `display` between `truncate` and `expand` and saves through `PUT /api/views`.

- [ ] **Step 1: Build:** `npm run build`. Expected: no errors.
- [ ] **Step 2: Manual check:**
  - add a note and confirm `jira/notes/<KEY>.md` has `key`/`jira_id` front matter
  - edit that file in a text editor while the cell is open, then save in the app, and confirm the conflict warning appears and the file is unchanged until you pick Overwrite
  - pick a Category and confirm the front matter changed and the body is identical (check with `git diff --no-index` against a copy)
  - toggle expand/truncate and confirm `views.yaml` updated
- [ ] **Step 3: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `feat: inline note and custom column editing`.

---

### Task 11: Filter bar, view editor

**Files:**
- Create: `src/web/filterBar.ts`, `src/web/viewEditor.ts`
- Modify: `src/web/main.ts`

**Interfaces:**
- Consumes: `applyFilters`, `sortRows` (Task 6), and `api.saveViews(views)`
- Produces:
  - `renderFilterBar(container: HTMLElement, view: View, columns: ColumnsConfig, totals: { shown: number; total: number }, onChange: (filters: Filters) => void): void`
  - `openViewEditor(view: View | null, columns: ColumnsConfig, onSave: (v: View) => void, onDelete?: () => void): void`

Behaviour (call 9 and the "Decided by the user" list):
- **Filter bar:** an "Add filter" menu that lists the custom columns.
  - A select column offers multi-select checkboxes of its options plus "is empty" and "is not empty".
  - A text column offers "contains" plus empty and not empty.
  - Active filters show as chips (`Category: Tech debt, Quick win ×`), with **Clear filters** and **Showing N of M**.
  - Every change saves the view through `PUT /api/views`.
- **The UI never edits option lists.**
- **View editor:** a modal (`<dialog>`) opened by "+ view" or by the edit icon on a tab. Fields: name, JQL (textarea) and limit.
  - The column list holds all builtin and custom columns, each with a show/hide checkbox, ↑/↓ reorder buttons, and `display` for note/groom.
  - A new view's `id` is a slug of the name, made unique.
  - Delete asks for confirmation inside the dialog (no `window.confirm`).
  - Saving writes `views.yaml` and refreshes the view.

- [ ] **Step 1: Build:** `npm run build`. Expected: no errors.
- [ ] **Step 2: Manual check:**
  - create a "Payments" view from the UI and confirm it appears in `views.yaml`
  - reorder and hide columns and confirm the table and file update
  - filter Category = Tech debt and confirm "Showing 1 of N" and the chip, then reload the page and confirm the filter persists
  - hand-edit a filter in `views.yaml` and confirm the UI picks it up live
- [ ] **Step 3: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `feat: local filter bar and view editor`.

---

### Task 12: Drill-in drawer, copy buttons, orphans

**Files:**
- Create: `src/web/drawer.ts`
- Modify: `src/web/main.ts`

**Interfaces:**
- Consumes: `api.ticket(key)`, `api.copy(key, kind)`, `api.orphans()`
- Produces: `openDrawer(key: string): void`, `closeDrawer(): void`

Behaviour:
- **Layout:** a right-hand panel about 60% wide that closes on Esc or ×.
  - The header shows the key, summary, status and points, the orange "Jira updated since…" marker when it applies, and the buttons **Copy ticket**, **Copy notes**, **Copy both for Claude**, **Copy groom prompt** and **Open in Jira ↗** (`target=_blank rel=noopener` to `ticket.url`).
  - The left column shows the description, acceptance criteria and comments (server HTML).
  - The right column shows your note, editable with a larger textarea (`editNote` from Task 10), and the full groom output rendered below it in the tinted style.
- **Copying:** uses `navigator.clipboard.writeText` with the text from the copy route and shows a brief "Copied" toast.
- **Live updates:** while the drawer is open, live `note`/`groom` events for that key re-render it. They never replace a textarea that's being edited; show a "changed on disk" notice instead.
- **Orphans:** when `api.orphans()` returns some, an "N orphaned notes" link in the header lists them with their file paths.

- [ ] **Step 1: Build:** `npm run build`. Expected: no errors.
- [ ] **Step 2: Manual check:**
  - open a ticket from the personal project, then try each copy button and paste into a text editor to confirm the call 12 formats
  - Open in Jira goes to the right ticket
  - a description containing `<b>x</b>` shows the literal text
  - run your Claude `groom-work-item` (with the save instruction added) and watch the drawer update
  - move a test ticket to another project in Jira, refresh, and confirm the note file is renamed and the `key` front matter updated
- [ ] **Step 3: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `feat: ticket drill-in with copy actions and orphans list`.

---

### Task 13: Setup, pack, README

**Files:**
- Create: `scripts/setup.ts`, `scripts/pack.ts`, `README.md`, `test/pack.test.ts`

**Interfaces:**
- Produces:
  - `npm run setup`:
    - uses `node:readline/promises` to prompt for the Jira site URL, email, API token (input not echoed), whether it's a scoped token (if yes, fetch `<site>/_edge/tenant_info` and store its `cloudId` as `JIRA_CLOUD_ID`), default project key and `NOTES_DIR` (with the default shown)
    - writes `envFilePath()` with mode `0600`, creating `~/.config/atlassian-notes/` as `0700`
    - if the file exists, asks before overwriting
    - then makes one `GET /rest/api/3/myself` to verify, and prints "Connected as {displayName}" or Jira's error
  - `npm run pack`:
    - runs `zip -r atlassian-notes.zip` over exactly `package.json package-lock.json tsconfig.json tsconfig.web.json .env.example README.md examples scripts src public/index.html`, in the app's parent directory
    - prints the path
    - exports `PACK_INCLUDE: string[]` for the test

README sections:
- what it is
- install (Node ≥ 22.18, `npm install`, `npm run setup`, `npm start`)
- the API token: recommend a scoped token with only `read:jira-work` and `read:jira-user`, and explain that scoped tokens go through `api.atlassian.com` (setup handles the cloud id). A classic token also works.
- where data lives and that it never touches the app folder
- `views.yaml`/`columns.yaml` reference, including how to find your story points and sprint custom field ids
- the **groom file contract** (call 4), plus the one-line instruction to add to a Claude skill
- sharing with `npm run pack`
- privacy: GET-only, localhost-only, no external requests
- that comments in `views.yaml` are lost when it is saved from the UI

- [ ] **Step 1: Write the failing test** `test/pack.test.ts`. `PACK_INCLUDE` doesn't contain `.env`, `node_modules`, `public/js`, `public/app.css` or anything starting with `~` or `/`. Every entry exists on disk.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the scripts and write the README.
- [ ] **Step 4: Verify:**
  - `npm test` passes
  - `npm run pack && unzip -l ../atlassian-notes.zip` lists no `.env`, `node_modules`, notes or cache
  - unzip to a temp dir, then `npm install && npm start` there works using the existing `~/.config` env (spec "Done looks like")
- [ ] **Step 5: Commit** `feat: setup and pack scripts, README`.
