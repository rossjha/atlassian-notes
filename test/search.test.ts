import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordClause, splitOrderBy, ticketKeyFromInput, withKeyword } from "../src/shared/search.ts";

test("ticketKeyFromInput: a key is upper-cased", () => {
  assert.equal(ticketKeyFromInput("abc-123", "ABC"), "ABC-123");
  assert.equal(ticketKeyFromInput("  XY_Z-7 ", "ABC"), "XY_Z-7");
});

test("ticketKeyFromInput: a bare number uses the default project", () => {
  assert.equal(ticketKeyFromInput("123", "ABC"), "ABC-123");
  assert.equal(ticketKeyFromInput(" 42 ", "abc"), "ABC-42");
  assert.equal(ticketKeyFromInput("0", "ABC"), null);
  assert.equal(ticketKeyFromInput("123", null), null);
});

test("ticketKeyFromInput: a Jira browse link", () => {
  assert.equal(ticketKeyFromInput("https://example.atlassian.net/browse/ABC-123", "ZZ"), "ABC-123");
  assert.equal(ticketKeyFromInput("https://example.atlassian.net/browse/ABC-123?focusedCommentId=9#x", "ZZ"), "ABC-123");
});

test("ticketKeyFromInput: selectedIssue wins over other keys in the link", () => {
  assert.equal(
    ticketKeyFromInput("https://example.atlassian.net/jira/software/c/projects/ABC/boards/1?selectedIssue=ABC-77", "ZZ"),
    "ABC-77",
  );
  assert.equal(ticketKeyFromInput("https://example.atlassian.net/browse/ABC-1?selectedIssue=DEF-2", "ZZ"), "DEF-2");
});

test("ticketKeyFromInput: other links fall back to the last key in the path", () => {
  assert.equal(ticketKeyFromInput("https://example.atlassian.net/jira/software/projects/ABC/issues/ABC-9", "ZZ"), "ABC-9");
});

test("ticketKeyFromInput: nothing usable is null", () => {
  assert.equal(ticketKeyFromInput("", "ABC"), null);
  assert.equal(ticketKeyFromInput("hello", "ABC"), null);
  assert.equal(ticketKeyFromInput("https://example.atlassian.net/wiki/spaces/X/pages/123/Title", "ABC"), null);
  assert.equal(ticketKeyFromInput("ABC-0", "ABC"), null);
});

test("keywordClause escapes quotes and backslashes", () => {
  assert.equal(keywordClause("auth"), 'text ~ "auth"');
  assert.equal(keywordClause('say "hi" \\ there'), 'text ~ "say \\"hi\\" \\\\ there"');
});

test("withKeyword: empty keyword leaves the JQL alone", () => {
  assert.equal(withKeyword("project = ABC", ""), "project = ABC");
  assert.equal(withKeyword("project = ABC", "   "), "project = ABC");
  assert.equal(withKeyword("project = ABC", undefined), "project = ABC");
});

test("withKeyword: wraps the query and ANDs the clause", () => {
  assert.equal(withKeyword("project = ABC OR labels = x", " auth "), '(project = ABC OR labels = x) AND text ~ "auth"');
});

test("withKeyword: the clause goes before ORDER BY", () => {
  assert.equal(withKeyword("project = ABC order by rank ASC", "auth"), '(project = ABC) AND text ~ "auth" order by rank ASC');
  assert.equal(withKeyword("ORDER BY updated DESC", "auth"), 'text ~ "auth" ORDER BY updated DESC');
});

test("withKeyword: ORDER BY inside a quoted value is not the ORDER BY clause", () => {
  assert.equal(withKeyword('summary ~ "order by" ORDER BY key', "x"), '(summary ~ "order by") AND text ~ "x" ORDER BY key');
});

test("splitOrderBy separates the ORDER BY clause, ignoring quoted text", () => {
  assert.deepEqual(splitOrderBy("project = ABC ORDER BY key"), { where: "project = ABC", orderBy: "ORDER BY key" });
  assert.deepEqual(splitOrderBy("project = ABC"), { where: "project = ABC", orderBy: "" });
  assert.deepEqual(splitOrderBy('summary ~ "order by"'), { where: 'summary ~ "order by"', orderBy: "" });
});
