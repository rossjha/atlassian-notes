// Heroicons (https://heroicons.com, MIT licence, Tailwind Labs), 24px outline set.
// Inlined as path data and built with createElementNS, so there is no network request and no innerHTML (CSP-safe).

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
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
