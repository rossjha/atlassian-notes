// Custom links for the top bar, from links.yaml in the notes folder. Parsing is shared by the server (which
// reports warnings) and typed for the web (which draws the icons).

/** Built-in icon names a link can use (Heroicons outline, bundled in src/web/icons.ts). */
export const LINK_ICON_NAMES = [
  "link", "globe", "map", "book", "bookmark", "calendar", "chart", "presentation", "chat",
  "clipboard", "cube", "document", "flag", "lightbulb", "rocket", "grid", "star", "team",
] as const;
export type LinkIconName = (typeof LINK_ICON_NAMES)[number];

export type LinkIcon = { kind: "named"; name: LinkIconName } | { kind: "text"; text: string };

export interface NavLink {
  name: string;
  url: string;
  /** null: the button shows the name instead. */
  icon: LinkIcon | null;
  /** Open in a new browser tab (the default) or replace this page. */
  newTab: boolean;
}

/** Up to this many characters (graphemes) an unknown icon value is treated as an emoji/short text. */
const MAX_TEXT_ICON = 2;

function graphemes(s: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates parsed links.yaml. Bad entries are skipped with a warning each; good ones are kept. */
export function parseLinks(raw: unknown): { links: NavLink[]; warnings: string[] } {
  const links: NavLink[] = [];
  const warnings: string[] = [];
  if (raw === null || raw === undefined) return { links, warnings };
  if (!isObj(raw)) return { links, warnings: ["top level must be a mapping with a links: list"] };
  if (raw.links === undefined || raw.links === null) return { links, warnings };
  if (!Array.isArray(raw.links)) return { links, warnings: ["links must be a list"] };
  raw.links.forEach((entry, i) => {
    const where = `link ${i + 1}`;
    if (!isObj(entry)) return warnings.push(`${where} must be a mapping with name and url`);
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) return warnings.push(`${where} needs a name`);
    let url: URL;
    try {
      url = new URL(String(entry.url ?? ""));
    } catch {
      return warnings.push(`"${name}" needs a full url starting with https:// or http://`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return warnings.push(`"${name}" url must start with https:// or http://`);
    }
    let icon: LinkIcon | null = null;
    if (typeof entry.icon === "string" && entry.icon.trim()) {
      const v = entry.icon.trim();
      if ((LINK_ICON_NAMES as readonly string[]).includes(v)) icon = { kind: "named", name: v as LinkIconName };
      else if (graphemes(v) <= MAX_TEXT_ICON) icon = { kind: "text", text: v };
      else warnings.push(`"${name}" icon "${v}" is not one of: ${LINK_ICON_NAMES.join(", ")} (or an emoji)`);
    }
    let newTab = true;
    if (typeof entry.newTab === "boolean") newTab = entry.newTab;
    else if (entry.newTab !== undefined && entry.newTab !== null) warnings.push(`"${name}" newTab must be true or false`);
    links.push({ name, url: url.href, icon, newTab });
  });
  return { links, warnings };
}
