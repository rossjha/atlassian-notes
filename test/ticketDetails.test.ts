import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ticket } from "../src/shared/types.ts";
import { groupLinks, sprintLabel } from "../src/web/ticketDetails.ts";

const base: Ticket = {
  id: "1", key: "AAA-1", url: "https://jira.invalid/browse/AAA-1", summary: "s", status: "To Do", statusCategory: "new",
  type: "Story", priority: null, assignee: null, reporter: null, storyPoints: null, parent: null, labels: [], sprint: null, updated: "",
};

test("groupLinks groups by phrase in first-seen order and drops duplicate keys", () => {
  const t: Ticket = { ...base, links: [
    { type: "blocks", direction: "outward", key: "AAA-2" },
    { type: "is blocked by", direction: "inward", key: "AAA-3" },
    { type: "blocks", direction: "outward", key: "AAA-4" },
    { type: "blocks", direction: "outward", key: "AAA-2" },
  ] };
  assert.deepEqual(groupLinks(t), [
    { phrase: "blocks", keys: ["AAA-2", "AAA-4"] },
    { phrase: "is blocked by", keys: ["AAA-3"] },
  ]);
});

test("groupLinks handles caches written before links existed", () => {
  assert.deepEqual(groupLinks(base), []);
});

test("sprintLabel prefers the active sprint, then the latest, then the legacy field", () => {
  assert.equal(sprintLabel({ ...base, sprints: [{ name: "S1", state: "closed" }, { name: "S2", state: "active" }, { name: "S3", state: "future" }] }), "S2");
  assert.equal(sprintLabel({ ...base, sprints: [{ name: "S1", state: "closed" }, { name: "S3", state: "future" }] }), "S3");
  assert.equal(sprintLabel({ ...base, sprint: "Legacy" }), "Legacy");
  assert.equal(sprintLabel(base), null);
});
