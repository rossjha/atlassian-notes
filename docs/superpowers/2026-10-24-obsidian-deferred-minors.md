# Phase 4a (Obsidian-ready notes): deferred minors

Recorded during review of `feat/obsidian-ready-notes`. None block use. The final reviewer triaged each one as fine to leave.

- **Sprint selection:** the legacy `sprint` is picked from the unfiltered sprint list. It can be null when the active entry has no name. This is unchanged existing behaviour.
- **Untested detail call:** no test checks that `getIssueDetail` returns `links` and `sprints`. It uses the same `mapTicket` function, so it should.
- **Missing link type:** a link with no type renders with an empty type (`""`). Jira always supplies one.
- **Link type whitespace:** `link.type` isn't whitespace-collapsed in the body line. Jira's link phrases are single-line.
- **Test gaps:**
  - Prune safety: lowercase key-like files and non-`.md` files.
  - A redundant README write in a test.
  - The debounce test asserts only the run count.
- **Name collision:** a custom column literally named `note_<reserved>` could collide with a namespaced property.
- **Shutdown timing:** a debounce timer pending at shutdown is dropped. The next startup refresh catches up.
- **Sync cost:**
  - Every note, groom or columns event re-renders all ticket files. That's about 250 ms at 1,500 tickets, which is acceptable because syncs are debounced.
  - `getViewIds` re-reads `views.yaml` and `columns.yaml` on each sync.
- **README wording:** the data-tree line says "generated" twice.
