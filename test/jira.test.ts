import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiraClient, JiraError } from "../src/server/jira.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const FIELDS = { storyPoints: "customfield_10016", sprint: "customfield_10020", acceptanceCriteria: "customfield_10030" };
const SITE = "https://example.atlassian.net";

interface Call { url: string; method?: string; headers?: Record<string, string> }

function fakeFetch(responses: { status?: number; body: string }[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, headers: init?.headers as Record<string, string> });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const client = (fetchFn: typeof fetch, apiBase = SITE) =>
  createJiraClient({ apiBase, siteUrl: SITE, email: "me@example.com", token: "secret-token", fields: FIELDS }, fetchFn);

test("search follows nextPageToken and combines pages", async () => {
  const { fn, calls } = fakeFetch([{ body: fixture("search-page1.json") }, { body: fixture("search-page2.json") }]);
  const tickets = await client(fn).search("project = PAY", 500);
  assert.equal(tickets.length, 5);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("nextPageToken"), "t2");
  assert.equal(new URL(calls[0].url).searchParams.get("jql"), "project = PAY");
  const fields = new URL(calls[0].url).searchParams.get("fields")!;
  assert.ok(fields.includes("customfield_10016") && fields.includes("customfield_10020"));
  assert.ok(!fields.includes("customfield_10030"));
});

test("search respects limit", async () => {
  const { fn, calls } = fakeFetch([{ body: fixture("search-page1.json") }, { body: fixture("search-page2.json") }]);
  const tickets = await client(fn).search("x", 3);
  assert.equal(tickets.length, 3);
  assert.equal(new URL(calls[0].url).searchParams.get("maxResults"), "3");
  assert.equal(calls.length, 1);
});

test("every call is a GET against apiBase; ticket url uses siteUrl", async () => {
  const apiBase = "https://api.atlassian.com/ex/jira/cloud-1";
  const { fn, calls } = fakeFetch([{ body: fixture("search-page1.json") }, { body: fixture("search-page2.json") }]);
  const tickets = await client(fn, apiBase).search("x", 500);
  assert.ok(calls.every((c) => c.method === "GET" && c.url.startsWith(apiBase)));
  assert.match(calls[0].headers!.Authorization, /^Basic /);
  assert.equal(tickets[0].url, `${SITE}/browse/PAY-1`);
});

test("maps ticket fields", async () => {
  const { fn } = fakeFetch([{ body: fixture("search-page1.json") }, { body: fixture("search-page2.json") }]);
  const [a, b, c] = await client(fn).search("x", 500);
  assert.equal(a.id, "10001");
  assert.equal(a.status, "In Progress");
  assert.equal(a.statusCategory, "In Progress");
  assert.equal(a.type, "Story");
  assert.equal(a.storyPoints, 5);
  assert.equal(a.sprint, "Sprint 2");
  assert.deepEqual(a.parent, { key: "PAY-100", summary: "Checkout epic" });
  assert.equal(a.assignee, "Alex Example");
  assert.deepEqual(a.labels, ["backend", "payments"]);
  assert.equal(b.sprint, "Sprint 3");
  assert.equal(b.storyPoints, null);
  assert.equal(b.priority, null);
  assert.equal(b.parent, null);
  assert.equal(c.sprint, null);
  assert.equal(c.assignee, null);
});

test("unmapped story points gives null", async () => {
  const { fn } = fakeFetch([{ body: fixture("search-page1.json") }]);
  const c = createJiraClient({ apiBase: SITE, siteUrl: SITE, email: "e", token: "t", fields: { ...FIELDS, storyPoints: null } }, fn);
  const [a] = await c.search("x", 1);
  assert.equal(a.storyPoints, null);
});

test("400 gives JiraError with Jira messages", async () => {
  const { fn } = fakeFetch([{ status: 400, body: JSON.stringify({ errorMessages: ["Error in the JQL Query: bad"], errors: { jql: "oops" } }) }]);
  await assert.rejects(client(fn).search("bad", 10), (e: unknown) => {
    assert.ok(e instanceof JiraError);
    assert.equal(e.status, 400);
    assert.ok(e.messages[0].startsWith("Error in the JQL"));
    assert.ok(e.messages.includes("oops"));
    return true;
  });
});

test("401 with non-JSON body gives JiraError", async () => {
  const { fn } = fakeFetch([{ status: 401, body: "<html>nope</html>" }]);
  await assert.rejects(client(fn).search("x", 10), (e: unknown) => {
    assert.ok(e instanceof JiraError);
    assert.equal(e.status, 401);
    assert.equal(e.messages.length, 1);
    assert.ok(!e.message.includes("secret-token"));
    return true;
  });
});

test("fetch rejection gives JiraError status 0", async () => {
  const fn = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(client(fn).search("x", 10), (e: unknown) => {
    assert.ok(e instanceof JiraError);
    assert.equal(e.status, 0);
    assert.ok(e.messages[0].startsWith("Could not reach Jira"));
    return true;
  });
});

test("getIssueBrief returns null on 404 and ids on success", async () => {
  const nf = fakeFetch([{ status: 404, body: JSON.stringify({ errorMessages: ["Issue does not exist"], errors: {} }) }]);
  assert.equal(await client(nf.fn).getIssueBrief("PAY-9"), null);
  const ok = fakeFetch([{ body: fixture("issue-detail.json") }]);
  assert.deepEqual(await client(ok.fn).getIssueBrief("PAY-1"), { id: "10001", key: "PAY-1" });
  assert.equal(new URL(ok.calls[0].url).searchParams.get("fields"), "summary");
});

test("getIssueDetail converts ADF and comments", async () => {
  const { fn, calls } = fakeFetch([{ body: fixture("issue-detail.json") }]);
  const d = await client(fn).getIssueDetail("PAY-1");
  assert.equal(d.ticket.key, "PAY-1");
  assert.equal(d.descriptionMd, "## Background\n\nCheckout fails on timeouts.");
  assert.equal(d.acceptanceCriteriaMd, "Retries happen three times");
  assert.equal(d.comments.length, 1);
  assert.equal(d.comments[0].author, "Sam Sample");
  assert.equal(d.comments[0].bodyMd, "Looks good");
  const fields = new URL(calls[0].url).searchParams.get("fields")!;
  assert.ok(fields.includes("description") && fields.includes("comment") && fields.includes("customfield_10030"));
});

test("issue key is URL-encoded in the path", async () => {
  const { fn, calls } = fakeFetch([{ body: fixture("issue-detail.json") }]);
  await client(fn).getIssueDetail("../x");
  assert.ok(calls[0].url.startsWith(`${SITE}/rest/api/3/issue/..%2Fx?`));
});
