// Command palette matching (⌘K). Pure, so it is unit-tested; the dialog lives in src/web/palette.ts.

export interface PaletteCommand {
  id: string;
  label: string;
  /** Section heading. Also searchable, so typing "theme" lists the Theme group. */
  group: string;
  /** Extra words that match without being shown. */
  keywords?: string[];
  /** Shortcut shown at the row's right edge. */
  hint?: string;
  /** Marks the current choice (the active tab, the current theme). */
  current?: boolean;
  run: () => void;
}

export interface PaletteGroup {
  heading: string;
  items: PaletteCommand[];
}

/** How well one lowercase word matches; 0 when it doesn't. */
function wordScore(c: PaletteCommand, word: string): number {
  const label = c.label.toLowerCase();
  if (label.startsWith(word)) return 4;
  if (label.split(/[\s\-–:/]+/).some((w) => w.startsWith(word))) return 3;
  if (label.includes(word)) return 2;
  if ([c.group, ...(c.keywords ?? [])].some((k) => k.toLowerCase().includes(word))) return 1;
  return 0;
}

/** Sum over the query's words; 0 unless every word matches. */
export function matchScore(c: PaletteCommand, words: string[]): number {
  let total = 0;
  for (const w of words) {
    const s = wordScore(c, w);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

/**
 * Groups the commands under their headings. An empty query keeps the given order. Otherwise only matching
 * commands are kept, best first within a group, and groups are ordered by their best match (ties keep their order).
 */
export function filterPalette(commands: PaletteCommand[], query: string): PaletteGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: { heading: string; best: number; items: { c: PaletteCommand; s: number }[] }[] = [];
  for (const c of commands) {
    const s = words.length ? matchScore(c, words) : 1;
    if (s === 0) continue;
    let g = groups.find((x) => x.heading === c.group);
    if (!g) groups.push((g = { heading: c.group, best: 0, items: [] }));
    g.items.push({ c, s });
    g.best = Math.max(g.best, s);
  }
  // Array.prototype.sort is stable, so equal scores keep their original order.
  if (words.length) {
    groups.sort((a, b) => b.best - a.best);
    for (const g of groups) g.items.sort((a, b) => b.s - a.s);
  }
  return groups.map((g) => ({ heading: g.heading, items: g.items.map((i) => i.c) }));
}
