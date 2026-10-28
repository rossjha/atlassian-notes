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
  assert.deepEqual(a.components, ["API", "Checkout"]);
  assert.deepEqual(b.components, []);
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

test("fetch rejection includes the cause code and message, never the token", async () => {
  const fn = (async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND acme.atlassian.net"), { code: "ENOTFOUND" });
    throw new TypeError("fetch failed", { cause });
  }) as typeof fetch;
  await assert.rejects(client(fn).search("x", 10), (e: unknown) => {
    assert.ok(e instanceof JiraError);
    assert.match(e.message, /Could not reach Jira: fetch failed \(ENOTFOUND: getaddrinfo ENOTFOUND acme\.atlassian\.net\)/);
    assert.ok(!e.message.includes("secret-token"));
    assert.ok(!e.message.includes(Buffer.from("me@example.com:secret-token").toString("base64")));
    return true;
  });
  const tls = (async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }) });
  }) as typeof fetch;
  await assert.rejects(client(tls).search("x", 10), /unable to get local issuer certificate/);
});

test("error body `message` (scoped-token 401 from api.atlassian.com) is shown", async () => {
  const { fn } = fakeFetch([{ status: 401, body: JSON.stringify({ code: 401, message: "Unauthorized; scope does not match" }) }]);
  await assert.rejects(client(fn).search("x", 10), (e: unknown) => {
    assert.ok(e instanceof JiraError);
    assert.deepEqual(e.messages, ["Unauthorized; scope does not match"]);
    return true;
  });
});

test("ticket updated and comment created are normalised to ISO UTC; invalid stays raw", async () => {
  const issue = JSON.parse(fixture("issue-detail.json"));
  issue.fields.updated = "2026-10-20T09:30:00.000+0100";
  issue.fields.comment.comments[0].created = "2026-10-19T10:00:00.000-0230";
  const { fn } = fakeFetch([{ body: JSON.stringify(issue) }]);
  const d = await client(fn).getIssueDetail("PAY-1");
  assert.equal(d.ticket.updated, "2026-10-20T08:30:00.000Z");
  assert.equal(d.comments[0].created, "2026-10-19T12:30:00.000Z");
  issue.fields.updated = "not a date";
  const bad = fakeFetch([{ body: JSON.stringify(issue) }]);
  assert.equal((await client(bad.fn).getIssueDetail("PAY-1")).ticket.updated, "not a date");
});

test("requests issuelinks", async () => {
  const { fn, calls } = fakeFetch([{ body: fixture("search-links.json") }]);
  await client(fn).search("x", 10);
  assert.ok(new URL(calls[0].url).searchParams.get("fields")!.split(",").includes("issuelinks"));
});

test("maps issue links and sprints", async () => {
  const { fn } = fakeFetch([{ body: fixture("search-links.json") }]);
  const [t] = await client(fn).search("x", 10);
  assert.deepEqual(t.links, [
    { type: "blocks", direction: "outward", key: "PAY-2" },
    { type: "is blocked by", direction: "inward", key: "PAY-3" },
  ]);
  assert.deepEqual(t.sprints, [{ name: "Sprint 11", state: "closed" }, { name: "Sprint 12", state: "active" }]);
  assert.equal(t.sprint, "Sprint 12");
});

test("issue without issuelinks or sprints maps to empty arrays", async () => {
  const { fn } = fakeFetch([{ body: fixture("search-links.json") }]);
  const [, t] = await client(fn).search("x", 10);
  assert.deepEqual(t.links, []);
  assert.deepEqual(t.sprints, []);
});

test("ignores malformed link entries and nameless sprints", async () => {
  const { fn } = fakeFetch([{ body: fixture("search-links.json") }]);
  const [, , t] = await client(fn).search("x", 10);
  assert.deepEqual(t.links, [{ type: "relates to", direction: "outward", key: "PAY-6" }]);
  assert.deepEqual(t.sprints, [{ name: "Sprint 13", state: "" }]);
});

test("analysis: extra and flag fields are fetched and mapped", async () => {
  const { fn, calls } = fakeFetch([{ body: fixture("search-analysis.json") }]);
  const c = createJiraClient({
    apiBase: SITE, siteUrl: SITE, email: "e", token: "t", fields: FIELDS,
    extraFields: () => ["customfield_00002", "customfield_00003", "customfield_00004", "customfield_00005"],
    flagField: () => "customfield_00001",
  }, fn);
  const [a, b] = await c.search("x", 10);
  const fields = new URL(calls[0].url).searchParams.get("fields")!.split(",");
  for (const f of ["customfield_00001", "customfield_00002", "customfield_00003", "customfield_00004"]) assert.ok(fields.includes(f), f);
  assert.equal(a.statusCategoryKey, "indeterminate");
  assert.equal(a.flagged, true);
  assert.deepEqual(a.extra, { customfield_00002: "Gold", customfield_00003: "plain text", customfield_00004: "A, B", customfield_00005: null });
  assert.deepEqual(a.sprints, [{ name: "Sprint 12", state: "active", startDate: "2026-10-26T09:00:00.000Z", endDate: "2026-11-06T17:00:00.000Z" }]);
  assert.deepEqual(a.links, [
    { type: "is blocked by", direction: "inward", key: "PAY-8", done: true },
    { type: "is blocked by", direction: "inward", key: "PAY-9", done: false },
  ]);
  assert.equal(b.flagged, false);
  assert.equal(b.statusCategoryKey, undefined);
  assert.deepEqual(b.extra, { customfield_00002: null, customfield_00003: null, customfield_00004: null, customfield_00005: null });
});

test("analysis: no extra or flag fields configured leaves tickets as before", async () => {
  const { fn } = fakeFetch([{ body: fixture("search-analysis.json") }]);
  const [a] = await client(fn).search("x", 10);
  assert.equal("extra" in a, false);
  assert.equal("flagged" in a, false);
});
