// The Analysis side of a view tab: cards drawn from the view's rows by the rules in shared/analysis.ts.
// Plain HTML/SVG, coloured by the theme's --chart-* tokens through classes (the CSP blocks style attributes;
// sizes go through the CSSOM). Clickable parts are buttons that drill down to the matching tickets.
import {
  attention, blockedReasons, categoryOf, chartsFor, complete, isMoving, isStalled, measureOf, NONE, OTHER, perPerson,
  split, sprintOf, sprintPosition, UNASSIGNED,
  type AnalysisConfig, type AnalysisSettings, type ChartSpec, type Drill, type Measure, type Split,
} from "../shared/analysis.ts";
import type { ColumnsConfig, Row } from "../shared/types.ts";
import { h } from "./dom.ts";
import { motionAllowed, motionMs } from "./motion.ts";

export interface AnalysisInput {
  rows: Row[];
  viewId: string;
  cfg: AnalysisConfig | null;
  columns: ColumnsConfig;
  now: Date;
  /** Play the entrance (first show after switching to Analysis or changing view; never on a live refresh). */
  animate: boolean;
}

export interface AnalysisHandlers {
  onDrill(d: Drill): void;
  onOpenTicket(key: string): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const svg = (tag: string, attrs: Record<string, string>): SVGElement => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const unit = (m: Measure, n: number): string => (m === "points" ? "pts" : n === 1 ? "ticket" : "tickets");
const colourClass = (value: string, i: number): string => (value === OTHER || value === NONE || value === UNASSIGNED ? "an-cother" : `an-c${(i % 5) + 1}`);

/** A width (0–1) that animates from 0 when motion plays. */
function grow(el: HTMLElement | SVGElement, frac: number, prop = "width"): void {
  el.dataset.anTo = String(Math.max(0, Math.min(1, frac)));
  el.dataset.anProp = prop;
  if (prop === "width") (el as HTMLElement).style.setProperty("width", pct(Math.max(0, Math.min(1, frac))));
}

function byLabel(by: string, columns: ColumnsConfig): string {
  if (by.startsWith("group:")) return by.slice(6);
  if (by.startsWith("column:")) return columns.custom[by.slice(7)]?.label ?? columns.jiraColumns[by.slice(7)]?.label ?? by.slice(7);
  if (by.startsWith("field:")) return by.slice(6);
  return by;
}

function card(span: string, title: string, sub: string | null, ...body: (Node | null)[]): HTMLElement {
  return h("section", { class: `an-card ${span}` },
    h("h3", { class: "an-title" }, title, sub ? h("em", {}, sub) : null),
    ...body.filter((b): b is Node => b !== null),
  );
}

function note(text: string): HTMLElement {
  return h("div", { class: "an-note" }, text);
}

/** done / in progress / to do as one stacked bar (fractions of `of`). */
function statusStack(done: number, inProgress: number, todo: number, of: number): HTMLElement {
  const bar = h("div", { class: "an-stack" });
  for (const [v, cls, label] of [[done, "an-done", "done"], [inProgress, "an-ip", "in progress"], [todo, "an-todo", "to do"]] as const) {
    if (v <= 0) continue;
    const seg = h("i", { class: cls, title: `${fmt(v)} ${label}` });
    grow(seg, of > 0 ? v / of : 0);
    bar.append(seg);
  }
  return bar;
}

function statusLegend(): HTMLElement {
  return h("div", { class: "an-legend" },
    h("span", {}, h("b", { class: "an-done" }), "Done"),
    h("span", {}, h("b", { class: "an-ip" }), "In progress"),
    h("span", {}, h("b", { class: "an-todo" }), "To do"),
  );
}

function splitNotes(s: Split, by: string, m: Measure): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (s.overlap > 0 && by.startsWith("group:")) out.push(note(`${s.overlap} ${s.overlap === 1 ? "ticket is" : "tickets are"} in more than one group, so shares can add up to more than 100%.`));
  if (m === "points" && s.unestimated > 0) out.push(note(`${s.unestimated} unestimated (counted as 0 pts).`));
  return out;
}

function drillValue(by: string, value: string, columns: ColumnsConfig): Drill {
  return { kind: "value", by, value, label: `${byLabel(by, columns)}: ${value}` };
}

// ---------- chart renderers ----------

function countdownCard(rows: Row[], s: AnalysisSettings, now: Date): HTMLElement {
  const sp = sprintOf(rows);
  if (!sp) return card("an-s12", "Sprint", null, note("No active sprint with dates in this view."));
  const p = sprintPosition(sp, s.freeze, now);
  const short = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const strip = h("div", { class: "an-days" });
  const labels = h("div", { class: "an-days an-days-labels" });
  const dayName = (d: Date) => "SMTWTFS"[d.getDay()]!;
  for (const d of p.days) {
    const cls = ["an-day", d.past ? "an-day-past" : "", d.today ? "an-day-today" : "", d.freeze ? "an-day-freeze" : ""].filter(Boolean).join(" ");
    strip.append(h("i", { class: cls, title: d.date.toDateString() + (d.freeze ? " · freeze" : "") }));
    labels.append(h("span", { class: d.today ? "an-today-label" : d.freeze ? "an-flag" : "" }, `${dayName(d.date)}${d.freeze ? " ❄" : ""}`));
  }
  const end = sp.end.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const status = p.notStarted ? "starts soon" : p.ended ? "ended" : `${p.daysLeft} working ${p.daysLeft === 1 ? "day" : "days"} left`;
  const freeze = s.freeze === null ? null
    : p.freezePassed ? h("div", { class: "an-kpi an-flag" }, "Freeze passed", h("small", {}, ` W${s.freeze.week}/D${s.freeze.day}`))
    : p.toFreeze !== null ? h("div", { class: "an-kpi an-flag" }, h("span", { class: "an-count" }, String(p.toFreeze)), h("small", {}, ` working ${p.toFreeze === 1 ? "day" : "days"} to freeze (W${s.freeze.week}/D${s.freeze.day})`))
    : null;
  const where = p.inSprint
    ? h("div", { class: "an-kpi" }, `W${p.week}/D${p.day}`, h("small", {}, ` today · ${sp.name}`))
    : h("div", { class: "an-kpi" }, p.notStarted ? `Starts ${short(sp.start)}` : "Ended", h("small", {}, ` · ${sp.name}`));
  return h("section", { class: "an-card an-s12 an-countdown" },
    where,
    h("div", { class: "an-days-wrap" }, strip, labels),
    freeze,
    h("div", { class: "an-kpi" }, status, h("small", {}, ` · ends ${end}`)),
  );
}

function kpiButton(value: string, unitText: string, drill: Drill | null, onDrill: (d: Drill) => void, flag = false): HTMLElement {
  const content = [h("span", { class: "an-count" }, value), h("small", {}, ` ${unitText}`)];
  if (!drill) return h("div", { class: `an-kpi${flag ? " an-flag" : ""}` }, ...content);
  return h("button", { type: "button", class: `an-kpi an-click${flag ? " an-flag" : ""}`, title: `Show these tickets`, onclick: () => onDrill(drill) }, ...content);
}

function headlinesCards(rows: Row[], s: AnalysisSettings, now: Date, onDrill: (d: Drill) => void): HTMLElement[] {
  const c = complete(rows);
  const m = s.measure;
  const inProgress = rows.filter((r) => categoryOf(r.ticket) === "inProgress").length;
  const moving = rows.filter((r) => isMoving(r, s, now));
  const stalled = rows.filter((r) => isStalled(r, s, now));
  const blocked = rows.map((r) => blockedReasons(r, s)).filter((x) => x.length);
  const unassigned = rows.filter((r) => !r.ticket.assignee && categoryOf(r.ticket) !== "done");
  const atRisk = stalled.reduce((n, r) => n + measureOf(r, "points"), 0);
  const flagged = blocked.filter((x) => x.includes("flagged")).length;
  const byLink = blocked.filter((x) => x.some((y) => y.startsWith("blocked by"))).length;
  const byStatus = blocked.filter((x) => x.some((y) => y.startsWith("status"))).length;
  const why = [flagged ? `${flagged} flagged` : "", byLink ? `${byLink} blocked by open ticket` : "", byStatus ? `${byStatus} by status` : ""].filter(Boolean).join(" · ");
  const doneFrac = m === "points" ? c.byPoints : c.byTickets;
  return [
    card("an-s3", "Done", null,
      kpiButton(pct(doneFrac), m === "points" ? `of ${fmt(c.totalPoints)} pts` : `of ${c.totalTickets} tickets`, { kind: "done", label: "Done" }, onDrill),
      note(`${c.doneTickets} done · ${inProgress} in progress · ${c.totalTickets - c.doneTickets - inProgress} to do${m === "points" && c.unestimated ? ` · ${c.unestimated} unestimated` : ""}`)),
    card("an-s3", "Moving", `updated ≤ ${s.movingDays}d`,
      kpiButton(String(moving.length), "tickets", moving.length ? { kind: "moving", label: "Moving" } : null, onDrill),
      note(`of ${inProgress} in progress`)),
    card("an-s3", "Stalled", `no update > ${s.stalledDays}d`,
      kpiButton(String(stalled.length), "tickets", stalled.length ? { kind: "stalled", label: "Stalled" } : null, onDrill, stalled.length > 0),
      note(`${fmt(atRisk)} pts at risk`)),
    card("an-s3", "Blocked", null,
      kpiButton(String(blocked.length), "tickets", blocked.length ? { kind: "blocked", label: "Blocked" } : null, onDrill, blocked.length > 0),
      h("div", { class: "an-note" },
        why ? `${why} · ` : "",
        unassigned.length
          ? h("button", { type: "button", class: "link-btn", onclick: () => onDrill({ kind: "unassigned", label: "Unassigned" }) }, `${unassigned.length} unassigned`)
          : "0 unassigned")),
  ];
}

function progressCard(rows: Row[], m: Measure): HTMLElement {
  let done = 0, ip = 0, todo = 0;
  for (const r of rows) {
    const v = measureOf(r, m);
    const c = categoryOf(r.ticket);
    if (c === "done") done += v; else if (c === "inProgress") ip += v; else todo += v;
  }
  const total = done + ip + todo;
  return card("an-s12", "Progress", `by status, ${m}`,
    statusStack(done, ip, todo, total),
    h("div", { class: "an-legend" },
      h("span", {}, h("b", { class: "an-done" }), `Done ${fmt(done)}`),
      h("span", {}, h("b", { class: "an-ip" }), `In progress ${fmt(ip)}`),
      h("span", {}, h("b", { class: "an-todo" }), `To do ${fmt(todo)}`)));
}

function rowButton(label: string, drill: Drill, onDrill: (d: Drill) => void, cls = ""): HTMLElement {
  return h("button", { type: "button", class: `an-label an-click ${cls}`, title: "Show these tickets", onclick: () => onDrill(drill) }, label);
}

function barsCard(rows: Row[], spec: ChartSpec, cfg: AnalysisConfig, m: Measure, columns: ColumnsConfig, onDrill: (d: Drill) => void): HTMLElement {
  const s = split(rows, spec.by!, cfg, m);
  const max = Math.max(...s.items.map((i) => i.measure), 0);
  const list = h("div", { class: "an-bars" });
  s.items.forEach((it) => {
    const fill = h("i", { class: it.value === OTHER || it.value === NONE || it.value === UNASSIGNED ? "an-cother" : "an-c3" });
    grow(fill, max > 0 ? it.measure / max : 0);
    list.append(
      rowButton(it.value, drillValue(spec.by!, it.value, columns), onDrill),
      h("div", { class: "an-bar", title: `${fmt(it.measure)} ${unit(m, it.measure)} · ${pct(it.share)}` }, fill),
      h("span", { class: "an-n" }, fmt(it.measure)),
    );
  });
  return card("an-s6", spec.title ?? `By ${byLabel(spec.by!, columns)}`, m, s.items.length ? list : note("No tickets."), ...splitNotes(s, spec.by!, m));
}

function donutCard(rows: Row[], spec: ChartSpec, cfg: AnalysisConfig, m: Measure, columns: ColumnsConfig, onDrill: (d: Drill) => void): HTMLElement {
  const s = split(rows, spec.by!, cfg, m);
  const sum = s.items.reduce((n, i) => n + i.measure, 0);
  const g = svg("g", { transform: "rotate(-90 21 21)", fill: "none", "stroke-width": "6" });
  const chart = svg("svg", { viewBox: "0 0 42 42", class: "an-donut", role: "img", "aria-label": `${spec.title ?? byLabel(spec.by!, columns)} donut` });
  let offset = 0;
  const legend = h("div", { class: "an-donut-legend" });
  s.items.forEach((it, i) => {
    const frac = sum > 0 ? it.measure / sum : 0;
    const cls = colourClass(it.value, i);
    const seg = svg("circle", { r: "15.9155", cx: "21", cy: "21", class: `an-seg ${cls}`, "stroke-dasharray": `${frac * 100} ${100 - frac * 100}`, "stroke-dashoffset": String(-offset) });
    seg.dataset.anTo = String(frac);
    seg.dataset.anProp = "dash";
    const title = svg("title", {});
    title.textContent = `${it.value}: ${fmt(it.measure)} ${unit(m, it.measure)} · ${pct(it.share)}`;
    seg.append(title);
    seg.addEventListener("click", () => onDrill(drillValue(spec.by!, it.value, columns)));
    g.append(seg);
    offset += frac * 100;
    legend.append(h("button", { type: "button", class: "an-legend-row an-click", title: "Show these tickets", onclick: () => onDrill(drillValue(spec.by!, it.value, columns)) },
      h("b", { class: cls }), `${it.value} `, h("span", { class: "an-n" }, `${fmt(it.measure)} · ${pct(it.share)}`)));
  });
  const centre = svg("text", { x: "21", y: "23", "text-anchor": "middle", class: "an-donut-total" });
  centre.textContent = fmt(s.total);
  chart.append(g, centre);
  return card("an-s6", spec.title ?? `Split by ${byLabel(spec.by!, columns)}`, m,
    s.items.length ? h("div", { class: "an-donut-wrap" }, chart, legend) : note("No tickets."), ...splitNotes(s, spec.by!, m));
}

function statusBarsCard(rows: Row[], spec: ChartSpec, cfg: AnalysisConfig, m: Measure, columns: ColumnsConfig, onDrill: (d: Drill) => void): HTMLElement {
  const s = split(rows, spec.by!, cfg, m);
  const max = Math.max(...s.items.map((i) => i.measure), 0);
  const list = h("div", { class: "an-rows" });
  for (const it of s.items) {
    list.append(h("div", { class: "an-row" },
      rowButton(it.value, drillValue(spec.by!, it.value, columns), onDrill, it.value === OTHER || it.value === NONE ? "an-muted" : ""),
      statusStack(it.done, it.inProgress, it.todo, max),
      h("span", { class: "an-n", title: `${pct(it.share)} of the view` }, `${fmt(it.measure)} · ${pct(it.share)}`)));
  }
  return card("an-s6", spec.title ?? `By ${byLabel(spec.by!, columns)}`, `${m}, by status`,
    s.items.length ? list : note("No tickets."), statusLegend(), ...splitNotes(s, spec.by!, m));
}

function ring(frac: number): SVGElement {
  const el = svg("svg", { viewBox: "0 0 42 42", class: "an-ring", role: "img", "aria-label": `${pct(frac)} complete` });
  const fill = svg("circle", { r: "15.9155", cx: "21", cy: "21", class: "an-ring-fill an-done", transform: "rotate(-90 21 21)", "stroke-dasharray": `${frac * 100} ${100 - frac * 100}` });
  fill.dataset.anTo = String(frac);
  fill.dataset.anProp = "dash";
  const text = svg("text", { x: "21", y: "23.5", "text-anchor": "middle", class: "an-ring-text" });
  text.textContent = pct(frac);
  el.append(svg("circle", { r: "15.9155", cx: "21", cy: "21", class: "an-ring-track" }), fill, text);
  return el;
}

function completeCard(rows: Row[], m: Measure, onDrill: (d: Drill) => void): HTMLElement {
  const c = complete(rows);
  const frac = m === "points" ? c.byPoints : c.byTickets;
  return card("an-s4", "Complete", null,
    h("div", { class: "an-donut-wrap" },
      h("button", { type: "button", class: "an-click an-ring-btn", title: "Show done tickets", onclick: () => onDrill({ kind: "done", label: "Done" }) }, ring(frac)),
      h("div", { class: "an-note" },
        `by points: ${fmt(c.donePoints)} of ${fmt(c.totalPoints)}`, h("br"),
        `by tickets: ${c.doneTickets} of ${c.totalTickets}`, h("br"),
        `${c.unestimated} unestimated`)));
}

function completeByCard(rows: Row[], spec: ChartSpec, cfg: AnalysisConfig, m: Measure, columns: ColumnsConfig, onDrill: (d: Drill) => void): HTMLElement {
  const s = split(rows, spec.by!, cfg, m);
  const list = h("div", { class: "an-rows" });
  for (const it of s.items) {
    const frac = it.measure > 0 ? it.done / it.measure : 0;
    const fill = h("i", { class: "an-done" });
    grow(fill, frac);
    list.append(h("div", { class: "an-row" },
      rowButton(it.value, drillValue(spec.by!, it.value, columns), onDrill),
      h("div", { class: "an-stack an-track", title: `${fmt(it.done)} of ${fmt(it.measure)} ${unit(m, it.measure)} done` }, fill),
      h("span", { class: "an-n" }, pct(frac))));
  }
  return card("an-s6", spec.title ?? `By ${byLabel(spec.by!, columns)}`, "% complete each", s.items.length ? list : note("No tickets."), ...splitNotes(s, spec.by!, m));
}

function perPersonCard(rows: Row[], s: AnalysisSettings, onDrill: (d: Drill) => void): HTMLElement {
  const people = perPerson(rows, s);
  const max = Math.max(...people.map((p) => p.open), 0);
  const list = h("div", { class: "an-bars" });
  for (const p of people) {
    const fill = h("i", { class: p.name === UNASSIGNED ? "an-cother" : p.low ? "an-c2" : "an-c1" });
    grow(fill, max > 0 ? p.open / max : 0);
    const label = `${p.name}${p.low ? " ↓ low" : ""}`;
    list.append(
      rowButton(label, { kind: "person", value: p.name, label: `Open work: ${p.name}` }, onDrill, p.low ? "an-low" : p.name === UNASSIGNED ? "an-muted" : ""),
      h("div", { class: "an-bar" }, fill),
      h("span", { class: `an-n${p.low ? " an-low" : ""}` }, `${fmt(p.open)}${p.unestimated ? ` +${p.unestimated}?` : ""}`),
    );
  }
  const unest = people.reduce((n, p) => n + p.unestimated, 0);
  return card("an-s6", "Open work per person", `${s.measure} not done`, people.length ? list : note("No tickets."),
    note(`"Low" = under ${s.lowLoad} ${s.measure === "points" ? "pts" : "tickets"}.${unest ? ` +N? = unestimated tickets (never flagged low).` : ""}`));
}

function attentionCard(rows: Row[], s: AnalysisSettings, now: Date, onOpen: (key: string) => void): HTMLElement {
  const items = attention(rows, s, now);
  if (items.length === 0) return card("an-s6", "Needs attention", "blocked, then stalled", note("Nothing blocked or stalled."));
  const table = h("table", { class: "an-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "Key"), h("th", {}, "Summary"), h("th", {}, "Who"), h("th", {}, "Why"))),
    h("tbody", {}, ...items.map((it) => {
      const t = it.row.ticket;
      return h("tr", { class: "an-click-row", tabindex: "0", title: "Open the ticket", onclick: () => onOpen(t.key), onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === "Enter") onOpen(t.key); } },
        h("td", { class: "key" }, t.key), h("td", { class: "an-summary" }, t.summary), h("td", {}, t.assignee ?? "—"), h("td", { class: "an-flag" }, it.blocked ? `⚑ ${it.why}` : it.why));
    })));
  return card("an-s6", "Needs attention", "blocked, then stalled", table);
}

// ---------- motion ----------

function playEntrance(root: HTMLElement): void {
  if (!motionAllowed()) return;
  const dur = motionMs("--motion-chart", 700);
  const stagger = motionMs("--motion-stagger", 40);
  const els = [...root.querySelectorAll<HTMLElement | SVGElement>("[data-an-to]")];
  els.forEach((el, i) => {
    const to = Number(el.dataset.anTo);
    const opts: KeyframeAnimationOptions = { duration: dur, delay: Math.min(i, 12) * stagger, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "backwards" };
    if (el.dataset.anProp === "dash") el.animate([{ strokeDasharray: "0 100" }, { strokeDasharray: `${to * 100} ${100 - to * 100}` }], opts);
    else el.animate([{ width: "0%" }, { width: pct(to) }], opts);
  });
  for (const el of root.querySelectorAll<HTMLElement>(".an-count")) {
    const target = Number.parseFloat(el.textContent ?? "");
    if (!Number.isFinite(target) || target === 0) continue;
    const suffix = (el.textContent ?? "").replace(/^[\d.]+/, "");
    const start = performance.now();
    const tick = (t: number): void => {
      const k = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = `${Math.round(target * eased)}${suffix}`;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// ---------- entry ----------

export function renderAnalysis(el: HTMLElement, input: AnalysisInput, handlers: AnalysisHandlers): void {
  const { rows, cfg, columns, now } = input;
  const config: AnalysisConfig = cfg ?? { settings: chartsFor(null, input.viewId, false).settings, groups: {}, views: {} };
  const { settings, charts } = chartsFor(cfg, input.viewId, sprintOf(rows) !== null);
  const grid = h("div", { class: "an-grid" });
  for (const spec of charts) {
    const m = spec.measure ?? settings.measure;
    switch (spec.type) {
      case "countdown": grid.append(countdownCard(rows, settings, now)); break;
      case "headlines": grid.append(...headlinesCards(rows, { ...settings, measure: m }, now, handlers.onDrill)); break;
      case "progress": grid.append(progressCard(rows, m)); break;
      case "bars": grid.append(barsCard(rows, spec, config, m, columns, handlers.onDrill)); break;
      case "donut": grid.append(donutCard(rows, spec, config, m, columns, handlers.onDrill)); break;
      case "statusBars": grid.append(statusBarsCard(rows, spec, config, m, columns, handlers.onDrill)); break;
      case "complete": grid.append(completeCard(rows, m, handlers.onDrill)); break;
      case "completeBy": grid.append(completeByCard(rows, spec, config, m, columns, handlers.onDrill)); break;
      case "perPerson": grid.append(perPersonCard(rows, { ...settings, measure: m }, handlers.onDrill)); break;
      case "attention": grid.append(attentionCard(rows, settings, now, handlers.onOpenTicket)); break;
    }
  }
  el.replaceChildren(rows.length === 0 ? h("p", { class: "empty-state" }, "No tickets in this view.") : grid);
  if (input.animate && rows.length) playEntrance(grid);
}
