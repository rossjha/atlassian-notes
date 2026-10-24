# Deferred minor findings (personal board, phase 2a)

From per-task reviews; the final whole-branch review triaged these as fine to defer. Items fixed in the final fix wave are omitted.

- Task 1: minor (deferred): no test for same-column move to middle index
- Task 1: minor (deferred): no test for missing board.yaml default / first add creates file
- Task 1: minor (deferred): DEFAULT_BOARD duplicates examples/board.example.yaml
- Task 1: minor (deferred): odd `case "add"` layout; serialiseBoard computed twice in updateBoard
- Task 1: minor (deferred): non-ENOENT read errors (EISDIR/EACCES) rethrown raw, not ConfigFileError — Task 3 locked/409 mapping should handle
- Task 2: minor (deferred): knownKeys duplicates ViewCache disk layout and scans all cache files per add
- Task 2: minor (deferred): rename() emit diff vs separate pre-read can spuriously emit/miss
- Task 2: minor (deferred): no tests for >24h re-probe, not-found pruning, non-404 skip log, loadBoard non-ConfigFileError log
- Task 2: minor (deferred): tiny refresh() coalescing window can cause one extra run
- Task 2: minor (deferred): board event emitted per rename inside refresh as well as at end
- Task 3: minor (deferred): app test Refresher built without board dep (Refresher→board path only unit-tested in refresher.test)
- Task 3: minor (deferred): redundant !startsWith("ERR_") check
- Task 4: minor (deferred): two overlapping toggles processed out of order by server can leave UI stale until next board event
- Task 4: minor (deferred): starError not reset when another source overwrites saveError
- Task 5: minor (deferred): board op failures still show on table tabs via saveError (star ops are table actions, acceptable)
- Task 5: minor (deferred): lane tabindex=-1 may show focus ring on background click; silent archive-count mismatch reset; discarded refresh gives no feedback
- Task 5: minor (deferred): loadBoard catch sets boardReady=false even with existing boardData
- Task 5: minor (deferred): board tab lacks the mockup's gold tab colour; doubled header when orphans present
- Task 6: minor (deferred): refresh-on-move of unknown key untested; refires per drag for no-cache cards
- Task 6: minor (deferred): no unit test for auto-move gating (could extract shouldAutoMove to shared)
- Task 7: minor (deferred): unnecessary casts in rowOps tests; no sortRows test for groomed
