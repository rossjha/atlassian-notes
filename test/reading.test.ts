import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterReading,
  guessFromUrl,
  isReadingId,
  makeReadingId,
  normaliseUrl,
  readingCardKey,
  readingIdFromCard,
  sortReading,
} from "../src/shared/reading.ts";
import type { ReadingItem } from "../src/shared/types.ts";

test("normaliseUrl trims, lower-cases host, drops a lone trailing slash, rejects non-http(s)", () => {
  assert.equal(normaliseUrl("  https://Acme.Atlassian.net/wiki/x/ "), "https://acme.atlassian.net/wiki/x");
  assert.equal(normaliseUrl("https://acme.example/a/?q=1"), "https://acme.example/a/?q=1");
  assert.equal(normaliseUrl("https://acme.example/"), "https://acme.example/");
  assert.equal(normaliseUrl("javascript:alert(1)"), null);
  assert.equal(normaliseUrl("ftp://x"), null);
  assert.equal(normaliseUrl("not a url"), null);
});

test("guessFromUrl: Confluence page title from the slug", () => {
  assert.deepEqual(
    guessFromUrl("https://acme.atlassian.net/wiki/spaces/PAY/pages/123/Retry+strategy+for+card+captures", "https://acme.atlassian.net"),
    { title: "Retry strategy for card captures", source: "confluence" },
  );
  assert.deepEqual(guessFromUrl("https://acme.atlassian.net/wiki/spaces/PAY/pages/123/Caf%C3%A9+notes", null), { title: "Café notes", source: "confluence" });
  assert.deepEqual(guessFromUrl("https://acme.atlassian.net/wiki/x/AbCd", null), { title: "acme.atlassian.net: AbCd", source: "confluence" });
  assert.deepEqual(guessFromUrl("https://wiki.acme.example/wiki/spaces/PAY/pages/9/Runbook", "https://wiki.acme.example"), { title: "Runbook", source: "confluence" });
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
  assert.equal(makeReadingId("2026-10-25T10:02:00Z", "Retry", new Set(["2026-10-25-retry", "2026-10-25-retry-2"])), "2026-10-25-retry-3");
  assert.equal(makeReadingId("2026-10-25T10:02:00Z", "!!!", new Set()), "2026-10-25-item");
  const long = makeReadingId("2026-10-25T10:02:00Z", "x".repeat(200), new Set());
  assert.ok(long.length <= 80 && !long.endsWith("-"));
  const longTaken = makeReadingId("2026-10-25T10:02:00Z", "x".repeat(200), new Set([long]));
  assert.ok(longTaken.length <= 80 && longTaken.endsWith("-2"), longTaken);
  assert.equal(makeReadingId("2026-10-25T10:02:00Z", "Café ünïcode", new Set()), "2026-10-25-cafe-unicode");
});

test("isReadingId accepts lowercase slugs up to 80 chars only", () => {
  assert.ok(isReadingId("2026-10-25-a"));
  assert.ok(!isReadingId("Bad Id"));
  assert.ok(!isReadingId("-leading"));
  assert.ok(!isReadingId("a".repeat(81)));
  assert.ok(!isReadingId("../x"));
});

test("reading card keys round-trip and never look like ticket keys", () => {
  assert.equal(readingIdFromCard(readingCardKey("2026-10-25-a")), "2026-10-25-a");
  assert.equal(readingIdFromCard("PAY-1"), null);
  assert.equal(readingIdFromCard("reading:Bad Id"), null);
});

function item(id: string, over: Partial<ReadingItem>): ReadingItem {
  return {
    id, url: `https://example.com/${id}`, title: id, status: "Pending", source: "web",
    category: null, tickets: [], created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z",
    mtimeMs: 0, note: "", groom: null, parseError: null, ...over,
  };
}
const a = item("a", { status: "Pending", category: "RFC", tickets: ["PAY-1"], created: "2026-10-01T00:00:00Z" });
const b = item("b", { status: "Complete", created: "2026-10-03T00:00:00Z", groom: { summary: "s", groomedAt: "2026-10-04T00:00:00Z" } });
const c = item("c", { status: "Read", category: "RFC", tickets: ["PAY-1", "PAY-2"], created: "2026-10-02T00:00:00Z", groom: { summary: "s", groomedAt: "2026-10-05T00:00:00Z" } });
const ids = (xs: ReadingItem[]) => xs.map((x) => x.id);

test("filterReading: status null is All; category and ticket filters AND together", () => {
  assert.deepEqual(ids(filterReading([a, b, c], { status: null, category: null, ticket: null })), ["a", "b", "c"]);
  assert.deepEqual(ids(filterReading([a, b, c], { status: "Pending", category: null, ticket: null })), ["a"]);
  assert.deepEqual(ids(filterReading([a, b, c], { status: null, category: "RFC", ticket: "PAY-2" })), ["c"]);
});

test("sortReading: created desc; groomed puts items without a groom last in both directions", () => {
  assert.deepEqual(ids(sortReading([a, b, c], "created", "desc")), ["b", "c", "a"]);
  assert.deepEqual(ids(sortReading([a, b, c], "groomed", "desc")), ["c", "b", "a"]);
  assert.deepEqual(ids(sortReading([a, b, c], "groomed", "asc")), ["b", "c", "a"]);
  assert.deepEqual(ids(sortReading([c, a, b], "title", "asc")), ["a", "b", "c"]);
});
