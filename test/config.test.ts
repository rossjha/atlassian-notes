import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, envFilePath, loadConfig, parseEnvFile } from "../src/server/config.ts";

const required = [
  "JIRA_BASE_URL=https://acme.atlassian.net/",
  "JIRA_EMAIL=a@b.c",
  "JIRA_API_TOKEN=tok",
  "JIRA_PROJECT=PAY",
].join("\n");

test("envFilePath default and override", () => {
  assert.equal(envFilePath({}, "/h"), "/h/.config/atlassian-notes/.env");
  assert.equal(envFilePath({ ATLASSIAN_NOTES_ENV: "/x/e" }, "/h"), "/x/e");
});

test("parseEnvFile", () => {
  const out = parseEnvFile(
    `# comment\n\nA=1\nB="quoted value"\nC='single'\nJIRA_API_TOKEN=ab=cd\n`,
  );
  assert.deepEqual(out, { A: "1", B: "quoted value", C: "single", JIRA_API_TOKEN: "ab=cd" });
});

test("defaults, trailing slash, api base", () => {
  const c = loadConfig({}, "/h", () => required);
  assert.equal(c.notesDir, "/h/atlassian-notes-data");
  assert.equal(c.refreshMinutes, 15);
  assert.equal(c.port, 4317);
  assert.equal(c.openBrowser, true);
  assert.equal(c.jiraBaseUrl, "https://acme.atlassian.net");
  assert.equal(c.jiraApiBase, "https://acme.atlassian.net");
  assert.equal(c.defaultProject, "PAY");
  const c2 = loadConfig({ JIRA_CLOUD_ID: "abc" }, "/h", () => required);
  assert.equal(c2.jiraApiBase, "https://api.atlassian.com/ex/jira/abc");
});

test("NOTES_DIR tilde expansion and env overrides file", () => {
  const c = loadConfig({ NOTES_DIR: "~/n", PORT: "5000", OPEN_BROWSER: "false" }, "/h", () => required);
  assert.equal(c.notesDir, "/h/n");
  assert.equal(c.port, 5000);
  assert.equal(c.openBrowser, false);
});

test("missing keys throw ConfigError", () => {
  const text = "JIRA_BASE_URL=https://a.net\nJIRA_PROJECT=P\n";
  assert.throws(
    () => loadConfig({}, "/h", () => text),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.deepEqual(e.missing, ["JIRA_EMAIL", "JIRA_API_TOKEN"]);
      assert.match(e.message, /JIRA_EMAIL/);
      assert.match(e.message, /\/h\/\.config\/atlassian-notes\/\.env/);
      return true;
    },
  );
});

test("ENOENT gives ConfigError mentioning path and npm run setup", () => {
  assert.throws(
    () =>
      loadConfig({}, "/h", () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /\/h\/\.config\/atlassian-notes\/\.env/);
      assert.match(e.message, /npm run setup/);
      return true;
    },
  );
});

test("only reads the env file path, never ./.env", () => {
  const paths: string[] = [];
  loadConfig({}, "/h", (p) => {
    paths.push(p);
    return required;
  });
  assert.deepEqual(paths, [envFilePath({}, "/h")]);
  assert.ok(!paths.some((p) => p.startsWith(process.cwd())));
});
