import { Marked } from "marked";

type Mark = { type?: string; attrs?: Record<string, unknown> };
type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Mark[];
  content?: AdfNode[];
};

const children = (n: AdfNode): AdfNode[] => (Array.isArray(n.content) ? n.content : []);

function plainText(n: AdfNode): string {
  if (typeof n.text === "string") return n.text;
  if (n.type === "hardBreak") return "\n";
  return children(n).map(plainText).join("");
}

function textNode(n: AdfNode): string {
  let out = n.text ?? "";
  const marks = Array.isArray(n.marks) ? n.marks : [];
  const has = (type: string) => marks.find((m) => m.type === type);
  if (has("code")) out = `\`${out}\``;
  if (has("em")) out = `_${out}_`;
  if (has("strong")) out = `**${out}**`;
  const link = has("link");
  if (link && typeof link.attrs?.href === "string") out = `[${out}](${link.attrs.href})`;
  return out;
}

function inline(n: AdfNode): string {
  switch (n.type) {
    case "text":
      return textNode(n);
    case "hardBreak":
      return "\n";
    case "mention":
      return "@" + String(n.attrs?.text ?? "").replace(/^@/, "");
    case "emoji":
      return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
    case "inlineCard":
      return String(n.attrs?.url ?? "");
    default:
      return children(n).map(inline).join("");
  }
}

function list(n: AdfNode, depth: number): string {
  const ordered = n.type === "orderedList";
  const pad = "  ".repeat(depth);
  return children(n)
    .map((item, i) => {
      const marker = ordered ? `${i + 1}. ` : "- ";
      const lines: string[] = [];
      let first = true;
      for (const child of children(item)) {
        if (child.type === "bulletList" || child.type === "orderedList") {
          lines.push(list(child, depth + 1));
        } else {
          const text = block(child, depth + 1).replace(/\n/g, "\n" + pad + "  ");
          lines.push(first ? `${pad}${marker}${text}` : `${pad}  ${text}`);
          first = false;
        }
      }
      return first ? `${pad}${marker}`.trimEnd() + (lines.length ? "\n" + lines.join("\n") : "") : lines.join("\n");
    })
    .join("\n");
}

function table(n: AdfNode): string {
  const lines: string[] = [];
  children(n).forEach((row, i) => {
    const cells = children(row).map((c) => children(c).map((b) => block(b, 0)).join(" ").replace(/\n+/g, " ").trim());
    lines.push(`| ${cells.join(" | ")} |`);
    if (i === 0 && children(row).some((c) => c.type === "tableHeader")) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
    }
  });
  return lines.join("\n");
}

function blocks(nodes: AdfNode[], depth: number): string {
  return nodes.map((n) => block(n, depth)).filter((s) => s !== "").join("\n\n");
}

function block(n: AdfNode, depth: number): string {
  switch (n.type) {
    case "doc":
      return blocks(children(n), depth);
    case "paragraph":
      return children(n).map(inline).join("");
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      return `${"#".repeat(level)} ${children(n).map(inline).join("")}`;
    }
    case "bulletList":
    case "orderedList":
      return list(n, depth);
    case "codeBlock": {
      const lang = typeof n.attrs?.language === "string" ? n.attrs.language : "";
      return "```" + lang + "\n" + plainText(n) + "\n```";
    }
    case "blockquote":
      return blocks(children(n), depth)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return table(n);
    case "text":
    case "hardBreak":
    case "mention":
    case "emoji":
    case "inlineCard":
      return inline(n);
    default:
      return plainText(n);
  }
}

export function adfToMarkdown(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  return block(node as AdfNode, 0);
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function safeHref(href: string): string | null {
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

const safeMarked = new Marked({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (safe === null) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdownSafe(md: string): string {
  return safeMarked.parse(md, { async: false });
}
