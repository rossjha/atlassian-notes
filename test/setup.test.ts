import { test } from "node:test";
import assert from "node:assert/strict";
import { apiBaseFor, isValidCloudId, parseSiteUrl, renderEnvFile } from "../scripts/setup.ts";
import { parseEnvFile } from "../src/server/config.ts";

test("parseSiteUrl reduces to an https origin", () => {
  assert.deepEqual(parseSiteUrl("acme.atlassian.net/"), { origin: "https://acme.atlassian.net", atlassianHost: true });
  assert.equal(parseSiteUrl(" https://acme.atlassian.net/jira/software/projects/PAY/boards/1?x=1 ").origin, "https://acme.atlassian.net");
});

test("parseSiteUrl rejects http, empty and garbage", () => {
  assert.throws(() => parseSiteUrl("http://acme.atlassian.net"), /https/);
  assert.throws(() => parseSiteUrl("ftp://acme.atlassian.net"), /https/);
  assert.throws(() => parseSiteUrl("   "), /required/);
  assert.throws(() => parseSiteUrl("https://"), /not a valid URL/);
});

test("parseSiteUrl flags non-atlassian.net hosts", () => {
  assert.equal(parseSiteUrl("https://jira.example.com").atlassianHost, false);
  assert.equal(parseSiteUrl("https://evil-atlassian.net").atlassianHost, false);
  assert.equal(parseSiteUrl("https://evil.atlassian.net.example.com").atlassianHost, false);
  assert.equal(parseSiteUrl("https://user:pw@acme.atlassian.net").origin, "https://acme.atlassian.net");
});

test("isValidCloudId", () => {
  assert.ok(isValidCloudId("0a1b2c3d-1111-2222-3333-444455556666"));
  assert.ok(!isValidCloudId("abc\nJIRA_API_TOKEN=x"));
  assert.ok(!isValidCloudId("../x"));
  assert.ok(!isValidCloudId(""));
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

test("renderEnvFile quotes awkward values and round-trips them", () => {
  const values = {
    baseUrl: "https://acme.atlassian.net",
    email: "a@b.c",
    token: ' tok with #hash and "dq" ',
    project: "PAY",
    notesDir: "/Users/o'brien/my notes",
  };
  const parsed = parseEnvFile(renderEnvFile(values));
  assert.equal(parsed.JIRA_API_TOKEN, values.token);
  assert.equal(parsed.NOTES_DIR, values.notesDir);
  assert.throws(() => renderEnvFile({ ...values, token: `a"b'c` }), /quotes/);
});
