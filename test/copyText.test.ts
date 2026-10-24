import { test } from "node:test";
import assert from "node:assert/strict";
import { bothMarkdown, groomPrompt, ticketMarkdown } from "../src/server/copyText.ts";
import type { GroomFile, IssueDetail, NoteFile } from "../src/shared/types.ts";

const base: IssueDetail = {
  ticket: {
    id: "1", key: "PAY-412", url: "https://acme.atlassian.net/browse/PAY-412",
    summary: "Retry failed card captures", status: "In Progress", statusCategory: "indeterminate",
    type: "Story", priority: null, assignee: null, reporter: null, storyPoints: null, parent: null,
    labels: [], sprint: null, updated: "2026-10-20T10:00:00Z",
  },
  descriptionMd: "Desc here",
  acceptanceCriteriaMd: null,
  comments: [],
};

test("ticketMarkdown with no comments has no Comments heading", () => {
  const md = ticketMarkdown(base);
  assert.equal(md.split("\n")[0], "# PAY-412: Retry failed card captures");
  assert.ok(!md.includes("## Comments"));
  assert.ok(!md.includes("## Acceptance criteria"));
  assert.equal(
    md,
    "# PAY-412: Retry failed card captures\nhttps://acme.atlassian.net/browse/PAY-412\n\n- Status: In Progress\n- Type: Story\n- Story points: –\n\n## Description\nDesc here",
  );
});

test("ticketMarkdown with AC, comments, points and empty description", () => {
  const d: IssueDetail = {
    ...base, descriptionMd: "", acceptanceCriteriaMd: "- a",
    ticket: { ...base.ticket, storyPoints: 5 },
    comments: [{ author: "Ann", created: "2026-10-02T23:59:00.000+0100", bodyMd: "hello" }],
  };
  const md = ticketMarkdown(d);
  assert.match(md, /- Story points: 5/);
  assert.match(md, /## Description\n_None_/);
  assert.match(md, /## Acceptance criteria\n- a/);
  assert.match(md, /## Comments\n### Ann — 2026-10-02\nhello$/);
});

test("bothMarkdown appends notes and groom output", () => {
  const note = { body: "mine" } as NoteFile;
  const groom = { body: "groomed" } as GroomFile;
  assert.equal(
    bothMarkdown(base, note, groom),
    `${ticketMarkdown(base)}\n\n# My notes\nmine\n\n# Groom output\ngroomed`,
  );
  assert.equal(
    bothMarkdown(base, null, null),
    `${ticketMarkdown(base)}\n\n# My notes\n_None_\n\n# Groom output\n_None_`,
  );
});

test("groomPrompt with the default template contains key and groom path", () => {
  const tpl =
    "Run groom-work-item on {key} ({url}). Save the result to {groomPath} with front matter: readiness, summary, groomed_at (ISO).";
  const out = groomPrompt(tpl, { key: "PAY-412", url: "https://u", groomPath: "/n/jira/groom/PAY-412.md" });
  assert.ok(out.includes("PAY-412"));
  assert.ok(out.includes("/n/jira/groom/PAY-412.md"));
  assert.ok(!out.includes("{"));
});
