import type { ColumnSetting, ColumnsConfig, Row } from "../shared/types.ts";
import { cellValue } from "../shared/rowOps.ts";
import { api } from "./api.ts";
import { copyToClipboard, h, relativeTime } from "./dom.ts";

function dot(title: string): HTMLElement {
  return h("span", { class: "stale-dot", title });
}

function copyPromptLink(key: string): HTMLElement {
  const link = h("button", { type: "button", class: "link-btn" }, "copy groom prompt");
  link.addEventListener("click", async (e) => {
    e.stopPropagation();
    link.textContent = (await copyToClipboard(() => api.copyPrompt(key))) ? "Copied" : "Copy failed";
    setTimeout(() => (link.textContent = "copy groom prompt"), 1500);
  });
  return link;
}

function plain(text: string | number | null, cls = ""): HTMLElement {
  return h("span", { class: cls }, text === null ? "" : String(text));
}

export function renderCell(row: Row, setting: ColumnSetting, columns: ColumnsConfig): HTMLElement {
  const t = row.ticket;
  switch (setting.id) {
    case "key":
      return h("a", { href: t.url, class: "key", "data-open": t.key }, t.key);
    case "summary":
      return plain(t.summary);
    case "status":
      return h("span", { class: `pill cat-${t.statusCategory.replace(/\W+/g, "-").toLowerCase()}` }, t.status);
    case "parent":
      return plain(t.parent ? `${t.parent.key} ${t.parent.summary}` : null, "text-muted");
    case "labels":
      return h("span", { class: "labels" }, ...t.labels.map((l) => h("span", { class: "pill" }, l)));
    case "updated":
      return h("span", { class: "text-muted", title: t.updated }, relativeTime(t.updated));
    case "note": {
      const box = h("div", { class: `note-box ${setting.display === "expand" ? "cell-wrap" : "cell-clip"}` }, row.note ? row.note.body : null);
      if (!row.note) box.classList.add("note-empty");
      const wrap = h("div", { class: "cell-flex" }, box);
      if (row.flags.jiraNewerThanNote) wrap.append(dot("Jira changed after this note was last edited"));
      return wrap;
    }
    case "groom": {
      const wrap = h("div", { class: "cell-flex" });
      if (!row.groom) {
        wrap.append(copyPromptLink(t.key));
        return wrap;
      }
      const g = row.groom;
      const box = h("div", { class: "groom-box" },
        h("div", { class: "groom-head" },
          g.readiness ? h("span", { class: "pill groom-readiness" }, g.readiness) : null,
          g.groomedAt ? h("span", { class: "text-muted", title: g.groomedAt }, relativeTime(g.groomedAt)) : null,
        ),
        h("div", { class: setting.display === "expand" ? "cell-wrap" : "cell-clip" }, g.summary),
      );
      wrap.append(box);
      if (row.flags.jiraNewerThanGroom) wrap.append(dot("Jira changed after this groom was written"));
      return wrap;
    }
    case "noteUpdated":
    case "groomed": {
      const ms = cellValue(row, setting.id);
      if (typeof ms !== "number") return plain(null);
      return h("span", { class: "text-muted", title: new Date(ms).toLocaleString() }, relativeTime(new Date(ms).toISOString()));
    }
    default: {
      const def = columns.custom[setting.id];
      if (def && def.type === "select") {
        const v = row.custom[setting.id];
        if (!v) return plain(null);
        const pill = h("span", { class: "pill" }, v);
        const color = def.options[v];
        if (color) {
          pill.style.setProperty("--pill-color", color);
          pill.classList.add("pill-colored");
        }
        return pill;
      }
      const v = cellValue(row, setting.id);
      return plain(v, setting.id === "storyPoints" ? "num" : "");
    }
  }
}
