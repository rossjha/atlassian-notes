import { test } from "node:test";
import assert from "node:assert/strict";
import { jiraSearchUrl } from "../src/shared/jiraUrls.ts";

test("jiraSearchUrl encodes the JQL into Jira's issue search", () => {
  assert.equal(
    jiraSearchUrl("https://example.atlassian.net", 'project = AAA AND status != "Done" ORDER BY rank'),
    "https://example.atlassian.net/issues/?jql=project%20%3D%20AAA%20AND%20status%20!%3D%20%22Done%22%20ORDER%20BY%20rank",
  );
  assert.equal(jiraSearchUrl("https://example.atlassian.net/", "a&b=c#d"), "https://example.atlassian.net/issues/?jql=a%26b%3Dc%23d");
});
