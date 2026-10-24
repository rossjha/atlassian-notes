import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidKeyClient } from "../src/shared/rowOps.ts";
import { parseFrontMatter, stringifyFrontMatter, isValidKey } from "../src/server/frontMatter.ts";

test("parses front matter and body", () => {
  const doc = parseFrontMatter("---\nkey: A-1\n---\nhello\n");
  assert.equal(doc.data.key, "A-1");
  assert.equal(doc.body, "hello\n");
  assert.equal(doc.hasFrontMatter, true);
  assert.equal(doc.error, null);
});

test("text without front matter is all body", () => {
  const doc = parseFrontMatter("# just text\n");
  assert.equal(doc.hasFrontMatter, false);
  assert.equal(doc.body, "# just text\n");
  assert.deepEqual(doc.data, {});
});

test("broken YAML reports error and keeps full text as body", () => {
  const text = "---\nkey: [unclosed\n---\nx";
  const doc = parseFrontMatter(text);
  assert.notEqual(doc.error, null);
  assert.equal(doc.body, text);
  assert.deepEqual(doc.data, {});
});

test("stringify with empty data returns body unchanged", () => {
  assert.equal(stringifyFrontMatter({}, "b"), "b");
});

test("stringify then parse round trips and quotes numeric-looking strings", () => {
  const text = stringifyFrontMatter({ key: "A-1", jira_id: "100" }, "body\n");
  const doc = parseFrontMatter(text);
  assert.equal(doc.data.jira_id, "100");
  assert.equal(doc.body, "body\n");
});

test("isValidKey", () => {
  for (const k of ["PAY-412", "AB_2-1"]) assert.equal(isValidKey(k), true, k);
  for (const k of ["pay-1", "../X-1", "PAY-0", "PAY-1.md", "PAY-1/..", ""]) {
    assert.equal(isValidKey(k), false, k);
  }
});

test("isValidKeyClient mirrors isValidKey", () => {
  for (const k of ["PAY-412", "AB_2-1", "pay-1", "../X-1", "PAY-0", "PAY-1.md", "PAY-1/..", "", " PAY-1", "PAY-1\n", "A-01", "1A-1"]) {
    assert.equal(isValidKeyClient(k), isValidKey(k), JSON.stringify(k));
  }
  assert.equal(isValidKeyClient("PAY-412"), true);
  assert.equal(isValidKeyClient("pay-1"), false);
});

test("blank front matter block parses as empty front matter", () => {
  const doc = parseFrontMatter("---\n\n---\nhello\n");
  assert.deepEqual(doc.data, {});
  assert.equal(doc.body, "hello\n");
  assert.equal(doc.error, null);
});

test("comments-only front matter is a parse error that keeps the full text (never dropped on rewrite)", () => {
  const text = "---\n# reviewed by Ann\n\n---\nhello\n";
  const doc = parseFrontMatter(text);
  assert.ok(doc.error);
  assert.equal(doc.body, text);
  assert.equal(doc.hasFrontMatter, true);
});
