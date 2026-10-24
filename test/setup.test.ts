import { test } from "node:test";
import assert from "node:assert/strict";
import { apiBaseFor, normalizeSiteUrl, renderEnvFile } from "../scripts/setup.ts";
import { parseEnvFile } from "../src/server/config.ts";

test("normalizeSiteUrl adds https and strips trailing slashes", () => {
  assert.equal(normalizeSiteUrl("acme.atlassian.net/"), "https://acme.atlassian.net");
  assert.equal(normalizeSiteUrl(" https://acme.atlassian.net// "), "https://acme.atlassian.net");
});

test("apiBaseFor uses the cloud id when present", () => {
  assert.equal(apiBaseFor("https://acme.atlassian.net", "abc-123"), "https://api.atlassian.com/ex/jira/abc-123");
  assert.equal(apiBaseFor("https://acme.atlassian.net", undefined), "https://acme.atlassian.net");
});

test("renderEnvFile round-trips through parseEnvFile", () => {
  const text = renderEnvFile({
    baseUrl: "https://acme.atlassian.net",
    cloudId: "abc-123",
    email: "a@b.c",
    token: "tok",
    project: "PAY",
    notesDir: "~/notes",
  });
  assert.deepEqual(parseEnvFile(text), {
    JIRA_BASE_URL: "https://acme.atlassian.net",
    JIRA_CLOUD_ID: "abc-123",
    JIRA_EMAIL: "a@b.c",
    JIRA_API_TOKEN: "tok",
    JIRA_PROJECT: "PAY",
    NOTES_DIR: "~/notes",
  });
});

test("renderEnvFile omits cloud id for classic tokens", () => {
  const text = renderEnvFile({ baseUrl: "https://a.atlassian.net", email: "e", token: "t", project: "P", notesDir: "~/n" });
  assert.ok(!("JIRA_CLOUD_ID" in parseEnvFile(text)));
});
