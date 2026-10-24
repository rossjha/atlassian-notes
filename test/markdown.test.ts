import { test } from "node:test";
import assert from "node:assert/strict";
import { adfToMarkdown, renderMarkdownSafe } from "../src/server/markdown.ts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, marks?: unknown[]) => ({ type: "text", text, ...(marks ? { marks } : {}) });

test("null, undefined and plain strings", () => {
  assert.equal(adfToMarkdown(null), "");
  assert.equal(adfToMarkdown(undefined), "");
  assert.equal(adfToMarkdown("plain text"), "plain text");
});

test("heading level 2", () => {
  assert.equal(adfToMarkdown(doc({ type: "heading", attrs: { level: 2 }, content: [t("Title")] })), "## Title");
});

test("paragraphs are separated by a blank line", () => {
  assert.equal(adfToMarkdown(doc(p(t("a")), p(t("b")))), "a\n\nb");
});

test("nested bullet list", () => {
  const li = (...c: unknown[]) => ({ type: "listItem", content: c });
  const list = {
    type: "bulletList",
    content: [li(p(t("a")), { type: "bulletList", content: [li(p(t("b")))] })],
  };
  assert.equal(adfToMarkdown(doc(list)), "- a\n  - b");
});

test("ordered list", () => {
  const li = (s: string) => ({ type: "listItem", content: [p(t(s))] });
  assert.equal(adfToMarkdown(doc({ type: "orderedList", content: [li("x"), li("y")] })), "1. x\n2. y");
});

test("code block with language", () => {
  const out = adfToMarkdown(doc({ type: "codeBlock", attrs: { language: "ts" }, content: [t("const a = 1;")] }));
  assert.equal(out, "```ts\nconst a = 1;\n```");
});

test("blockquote and rule", () => {
  assert.equal(adfToMarkdown(doc({ type: "blockquote", content: [p(t("q"))] }, )), "> q");
  assert.equal(adfToMarkdown(doc({ type: "rule" })), "---");
});

test("marks: link, strong, em, code", () => {
  assert.equal(adfToMarkdown(doc(p(t("site", [{ type: "link", attrs: { href: "https://x.y" } }])))), "[site](https://x.y)");
  assert.equal(adfToMarkdown(doc(p(t("b", [{ type: "strong" }])))), "**b**");
  assert.equal(adfToMarkdown(doc(p(t("i", [{ type: "em" }])))), "_i_");
  assert.equal(adfToMarkdown(doc(p(t("c", [{ type: "code" }])))), "`c`");
});

test("inline nodes: hardBreak, mention, emoji, inlineCard", () => {
  assert.equal(adfToMarkdown(doc(p(t("a"), { type: "hardBreak" }, t("b")))), "a\nb");
  assert.equal(adfToMarkdown(doc(p({ type: "mention", attrs: { text: "@Sam" } }))), "@Sam");
  assert.equal(adfToMarkdown(doc(p({ type: "mention", attrs: { text: "Sam" } }))), "@Sam");
  assert.equal(adfToMarkdown(doc(p({ type: "emoji", attrs: { text: "😀" } }))), "😀");
  assert.equal(adfToMarkdown(doc(p({ type: "inlineCard", attrs: { url: "https://j/x" } }))), "https://j/x");
});

test("table rows", () => {
  const cell = (type: string, s: string) => ({ type, content: [p(t(s))] });
  const out = adfToMarkdown(doc({
    type: "table",
    content: [
      { type: "tableRow", content: [cell("tableHeader", "a"), cell("tableHeader", "b")] },
      { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
    ],
  }));
  assert.equal(out, "| a | b |\n| --- | --- |\n| 1 | 2 |");
});

test("unknown node falls back to child text", () => {
  const out = adfToMarkdown(doc({ type: "panel", attrs: { panelType: "info" }, content: [p(t("warn"))] }));
  assert.ok(out.includes("warn"));
});

test("renderMarkdownSafe escapes block html", () => {
  const html = renderMarkdownSafe("<script>alert(1)</script>");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script"));
});

test("renderMarkdownSafe escapes inline html", () => {
  const html = renderMarkdownSafe("a <img src=x onerror=alert(1)> b");
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("renderMarkdownSafe drops unsafe link protocols", () => {
  const html = renderMarkdownSafe("[x](javascript:alert(1))");
  assert.ok(!html.includes('href="javascript'));
  assert.ok(!html.includes("<a"));
  assert.ok(html.includes("x"));
  assert.ok(!renderMarkdownSafe("[x](data:text/html,hi)").includes("<a"));
});

test("renderMarkdownSafe keeps http, https and mailto links", () => {
  assert.ok(renderMarkdownSafe("[x](https://example.com)").includes('href="https://example.com"'));
  assert.ok(renderMarkdownSafe("[x](http://example.com)").includes('href="http://example.com"'));
  assert.ok(renderMarkdownSafe("[x](mailto:a@b.c)").includes('href="mailto:a@b.c"'));
});

test("renderMarkdownSafe never emits images", () => {
  const html = renderMarkdownSafe("![x](https://example.com/a.png)");
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("x"));
});

test("renderMarkdownSafe renders task list items", () => {
  assert.ok(renderMarkdownSafe("- [ ] task").includes("<li>"));
});

test("renderMarkdownSafe renders basic markdown", () => {
  assert.ok(renderMarkdownSafe("**b**").includes("<strong>b</strong>"));
});
