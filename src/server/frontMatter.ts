import { parse, stringify } from "yaml";

export interface ParsedDoc {
  data: Record<string, unknown>;
  body: string;
  hasFrontMatter: boolean;
  error: string | null;
}

const KEY_RE = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

export class InvalidKeyError extends Error {
  constructor(key: string) {
    super(`Invalid ticket key: ${JSON.stringify(key)}`);
    this.name = "InvalidKeyError";
  }
}

export function parseFrontMatter(text: string): ParsedDoc {
  const none: ParsedDoc = { data: {}, body: text, hasFrontMatter: false, error: null };
  const open = text.startsWith("---\r\n") ? 5 : text.startsWith("---\n") ? 4 : 0;
  if (!open) return none;

  // Find a closing "---" line: either immediately (empty block) or after a newline.
  const rest = text.slice(open);
  const m = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!m) return none;
  const yamlText = rest.slice(0, m.index);
  const body = rest.slice(m.index + m[0].length);

  try {
    const parsed: unknown = parse(yamlText);
    if (parsed === null || parsed === undefined) {
      // Only a truly blank block is empty front matter. Comments-only (or `~`) would be
      // lost on rewrite, so treat it as unparseable and leave the file alone.
      if (yamlText.trim() === "") return { data: {}, body, hasFrontMatter: true, error: null };
      throw new Error("front matter has no fields (only comments or null)");
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("front matter must be a mapping");
    }
    return { data: parsed as Record<string, unknown>, body, hasFrontMatter: true, error: null };
  } catch (e) {
    return {
      data: {},
      body: text,
      hasFrontMatter: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function stringifyFrontMatter(data: Record<string, unknown>, body: string): string {
  if (Object.keys(data).length === 0) return body;
  return `---\n${stringify(data)}---\n${body}`;
}
