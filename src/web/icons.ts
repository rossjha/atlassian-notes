// Heroicons (https://heroicons.com, MIT licence, Tailwind Labs), 24px outline set.
// Inlined as path data and built with createElementNS, so there is no network request and no innerHTML (CSP-safe).

import { h } from "./dom.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  arrowPath: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99",
  magnifyingGlass: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

/** Icon-only Refresh button; spins and is disabled while busy. */
export function refreshButton(busy: boolean, disabled: boolean, onClick: () => void): HTMLElement {
  const label = busy ? "Refreshing…" : "Refresh from Jira";
  const btn = h("button", { type: "button", class: "icon-btn", title: label, "aria-label": label, onclick: onClick },
    icon("arrowPath", busy ? "icon-btn-svg icon-spin" : "icon-btn-svg"));
  if (busy || disabled) btn.setAttribute("disabled", "");
  return btn;
}
