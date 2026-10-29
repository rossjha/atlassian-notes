import type { Filters, Row } from "./types.ts";

export function cellValue(row: Row, columnId: string): string | number | null {
  const t = row.ticket;
  switch (columnId) {
    case "key": return t.key;
    case "summary": return t.summary;
    case "status": return t.status;
    case "type": return t.type;
    case "priority": return t.priority;
    case "assignee": return t.assignee;
    case "reporter": return t.reporter;
    case "storyPoints": return t.storyPoints;
    case "parent": return t.parent ? t.parent.key : null;
    case "labels": return t.labels.length ? t.labels.join(", ") : null;
    case "components": return t.components?.length ? t.components.join(", ") : null;
    case "sprint": return t.sprint;
    case "updated": return t.updated;
    case "note": return row.note ? row.note.body : null;
    case "groom": return row.groom ? `${row.groom.readiness ?? ""} ${row.groom.summary}`.trim() : null;
    case "noteUpdated": return row.note?.mtimeMs ?? null;
    case "groomed": {
      const ms = row.groom?.groomedAt ? Date.parse(row.groom.groomedAt) : NaN;
      return Number.isNaN(ms) ? null : ms;
    }
    default: return row.custom[columnId] ?? row.jira?.[columnId] ?? null;
  }
}

export function applyFilters(rows: Row[], filters: Filters): Row[] {
  const active = Object.entries(filters).filter(([, f]) => !(f.op === "oneOf" && f.values.length === 0));
  if (active.length === 0) return rows;
  return rows.filter((row) =>
    active.every(([col, f]) => {
      const raw = cellValue(row, col);
      const v = raw === null ? "" : String(raw);
      switch (f.op) {
        case "oneOf": return f.values.includes(v);
        case "empty": return v === "";
        case "notEmpty": return v !== "";
        case "contains": return v.toLowerCase().includes(f.text.toLowerCase());
      }
    }),
  );
}

function naturalKey(a: string, b: string): number {
  const pa = /^(.*?)-(\d+)$/.exec(a);
  const pb = /^(.*?)-(\d+)$/.exec(b);
  if (pa && pb) {
    const c = pa[1]!.localeCompare(pb[1]!, undefined, { sensitivity: "base" });
    return c !== 0 ? c : Number(pa[2]) - Number(pb[2]);
  }
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export function sortRows(rows: Row[], columnId: string, dir: "asc" | "desc"): Row[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row) => ({ row, v: cellValue(row, columnId) }))
    .sort((x, y) => {
      if (x.v === null && y.v === null) return 0;
      if (x.v === null) return 1;
      if (y.v === null) return -1;
      let c: number;
      if (typeof x.v === "number" && typeof y.v === "number") c = x.v - y.v;
      else if (columnId === "key") c = naturalKey(String(x.v), String(y.v));
      else c = String(x.v).localeCompare(String(y.v), undefined, { sensitivity: "base" });
      return c * sign;
    })
    .map((e) => e.row);
}

/** Mirrors the server's isValidKey (src/server/frontMatter.ts); used to validate the header search input. */
export function isValidKeyClient(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(key);
}
