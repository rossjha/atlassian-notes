# atlassian-notes

A small local web app for refining Jira tickets privately. It pulls tickets from Jira (read-only) into tabbed table views and lets you keep your own markdown notes beside each one, plus notes written by a Claude Code grooming skill. Notes are plain files on your disk. Nobody else sees them.

## Install

Requires Node 22.18 or newer.

```sh
npm install
npm run setup   # asks for site, email, token, default project; checks the connection
npm start       # builds the CSS/JS, starts on http://localhost:4317 and opens your browser
```

Your Jira settings are saved to `~/.config/atlassian-notes/.env` (mode 600), outside this folder. Set `ATLASSIAN_NOTES_ENV` to use a different file. The app never reads a `.env` in the app folder. `.env.example` lists every key (`NOTES_DIR`, `REFRESH_MINUTES`, `PORT`, `OPEN_BROWSER` are optional).

## The API token

Create one at <https://id.atlassian.com/manage-profile/security/api-tokens>.

- Recommended: a scoped token ("Create API token with scopes") with only `read:jira-work` and `read:jira-user`. Scoped tokens can't go through your `*.atlassian.net` address, so requests go via `api.atlassian.com`. `npm run setup` handles this: answer "y" to "scoped token" and it looks up your site's cloud id and stores it as `JIRA_CLOUD_ID`. Scoped tokens expire (at most one year), so re-run `npm run setup` when it stops working.
- A classic token also works. The app only ever makes GET requests either way.

Behind a corporate proxy that inspects TLS, Jira errors may say "unable to get local issuer certificate": point Node at your company's root certificate with `NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem npm start`.

## Where your data lives

Everything personal lives in `NOTES_DIR` (default `~/atlassian-notes-data`), never in the app folder:

```
views.yaml            tabs: name, JQL, columns, filters
board.yaml            your personal board: columns and card placement
columns.yaml          custom columns + Jira field mapping
jira/notes/KEY.md     your notes
jira/groom/KEY.md     groom output written by Claude (the app only reads it)
.cache/               last Jira results, so the app opens instantly
```

On first run, `views.yaml` and `columns.yaml` are created from `examples/` with your default project key filled in. Hand edits are picked up live. Note: the app rewrites `views.yaml` when you change a view in the UI, so comments you added to it are lost.

## views.yaml and columns.yaml

`views.yaml`: each view has an `id`, `name`, `jql`, ordered `columns` (each `id`, optionally `display: truncate`) and optionally `limit` (default 500). See `examples/views.example.yaml`. Built-in column ids: `key`, `summary`, `status`, `type`, `priority`, `assignee`, `reporter`, `storyPoints`, `parent`, `labels`, `sprint`, `updated`, plus `note` and `groom`.

`columns.yaml`: see `examples/columns.example.yaml`.

```yaml
jiraFields:
  storyPoints: customfield_10016   # differs per Jira site
  sprint: customfield_10020
custom:
  category:
    label: Category
    type: select                   # or: text
    options:
      Tech debt: "#e5b45b"
```

Optional keys:

- `jiraFields.acceptanceCriteria`: the `customfield_NNNNN` holding acceptance criteria, if your site has one. It is shown in the ticket drawer and included in "Copy ticket".
- `groomPrompt`: the text the "Copy groom prompt" button copies. Placeholders `{key}`, `{url}` and `{groomPath}` are filled in per ticket. The default asks for a skill called `groom-work-item` (the author's own); change it to name your own grooming skill or prompt.

Finding your field ids: open `https://<your-site>/rest/api/3/field` in a browser while logged in to Jira and search for "Story point estimate" and "Sprint". The `id` is the `customfield_NNNNN` value. Custom column values are stored in each note's front matter. Option lists are only edited in this file, but you filter on them from the UI.

## My board

The **★ My board** tab is a personal kanban for tickets you want to come back to, whatever view or search they came from. Moving a card never touches Jira.

- **Starring:** click the ☆ in the first column of any table view to put a ticket at the bottom of the first column. Click the ★ again to take it off. The ✕ on a card (shown on hover or focus) does the same.
- **Moving cards:** drag a card to another column or to a new place in its column; a blue bar shows where it will land. With a card focused (Tab to it), Alt+←/→ moves it to the previous or next column and Alt+↑/↓ moves it up or down one place. Enter opens the ticket.
- **Notes:** click a card's note box (or "+ add note") to edit the same note that the table and ticket panel use.
- **Columns:** they come from `board.yaml` in your notes folder, created from `examples/board.example.yaml` on first run. Edit the file to add, rename or reorder columns; the board updates live.

```yaml
columns: [Backlog, Doing, PEN, Done]
archiveColumn: Done
cards:                  # written by the app; order in a list = order on the board
  Backlog: []
  Doing: [PAY-412]
```

A card under an unknown column goes to the first column, and a repeated key is kept once. If `board.yaml` can't be parsed, the board shows the error and its controls (and the table stars) are disabled until you fix the file; the app never rewrites a file it couldn't read.
- **Archive:** the `archiveColumn` lane has an **Archive all** button (click it, then click "Archive N cards?" within 4 seconds). It only takes those cards off the board, like un-starring them. Your notes are kept.
- **Refresh:** the board fetches its tickets from Jira by key, independently of your JQL views. A ticket Jira can't find (deleted, or no permission) shows as "not found in Jira" and the rest of the board still loads.

### Using your board with Claude

`board.yaml` plus `jira/notes/<KEY>.md` describe the whole board, so Claude can read it as plain files. For example:

> Read my board.yaml and the notes for everything in Doing, then tell me which of them is ready to pick up and what is blocking the rest.

## Groom file contract

Claude (or any tool) writes `$NOTES_DIR/jira/groom/<KEY>.md`:

```markdown
---
key: PAY-412                 # optional; the app fills it in
jira_id: "10234"             # optional; the app fills it in
readiness: Needs work        # short free text
summary: 3 gaps in AC; suggest split into retry + alerting
groomed_at: 2026-10-22T14:03:00Z
---
(full groom output, any markdown)
```

The table shows `readiness`, `summary` and age. Without front matter, the first non-empty line is shown. The app never changes the body of a groom file.

To wire up your own Claude skill (for example `groom-work-item`), add this line to it:

> Save your output to `$NOTES_DIR/jira/groom/<KEY>.md` (default `~/atlassian-notes-data`) with front matter `readiness`, `summary` and `groomed_at` (ISO timestamp), followed by the full write-up.

## Sharing

`npm run pack` writes `atlassian-notes.zip` next to the app folder. It contains one top-level `atlassian-notes/` folder with only code, examples and this README: no token, env files, notes, cache or `node_modules`. Send that. Recipients unzip it, `cd atlassian-notes`, then follow Install above.

## Privacy

- Only HTTP GET requests, only to your Jira site (or `api.atlassian.com` for scoped tokens). The app cannot change anything in Jira.
- The server listens on 127.0.0.1 only. The page loads nothing from outside (CSP `default-src 'self'`): no CDNs, fonts, analytics or telemetry.
- The token lives only in `~/.config/atlassian-notes/.env`; `setup` never prints it.
