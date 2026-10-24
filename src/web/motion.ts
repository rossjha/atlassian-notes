// Motion helpers, ported from forge (packages/theme motion.ts + packages/shell nav-direction.ts @ 0bee37f).
// The CSS is gated on its own; these gates are for the JS that starts transitions or waits for exit animations.

export type NavDir = "forward" | "back";

/** Which way a tab switch moves along the tab bar (Kanban is index 0, then the views), or null for no page motion. */
export function tabNavDir(fromIndex: number, toIndex: number): NavDir | null {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
  return toIndex > fromIndex ? "forward" : "back";
}

/** False when the user asked for reduced motion or the page opted out with <html data-motion="off">. */
export function motionAllowed(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches && document.documentElement.dataset.motion !== "off";
}

/** A `--motion-*` duration token in ms (e.g. "240ms"), or `fallback` if it is missing or unparsable. */
export function motionMs(token: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const n = raw.endsWith("ms") ? Number.parseFloat(raw) : raw.endsWith("s") ? Number.parseFloat(raw) * 1000 : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

type StartViewTransition = (update: () => void) => unknown;

/**
 * Runs `update` (synchronous DOM work) inside a view transition when the browser supports it and motion is allowed.
 * `dir` lands on <html data-nav-dir> for the page-slide CSS. Browsers without view transitions (Firefox before 144)
 * get the same look from the Web Animations API: `pageEls` slide in from the side, and the tab underline glides from
 * where it was (FLIP). Element.animate() is not an inline style attribute, so CSP is unaffected.
 */
export function withPageTransition(dir: NavDir | null, update: () => void, pageEls: HTMLElement[] = []): void {
  const start = (document as { startViewTransition?: StartViewTransition }).startViewTransition;
  if (!dir || !motionAllowed()) {
    update();
    return;
  }
  if (typeof start === "function") {
    document.documentElement.dataset.navDir = dir;
    start.call(document, update);
    return;
  }
  const before = document.querySelector<HTMLElement>(".tab-indicator")?.getBoundingClientRect();
  update();
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--motion-ease").trim() || "ease-out";
  const enter = motionMs("--motion-enter", 360);
  const from = dir === "forward" ? "32px 0" : "-32px 0";
  for (const el of pageEls) {
    if (el.isConnected && !el.hidden) el.animate([{ opacity: 0, translate: from }, { opacity: 1, translate: "0 0" }], { duration: enter, easing });
  }
  const indicator = document.querySelector<HTMLElement>(".tab-indicator");
  const after = indicator?.getBoundingClientRect();
  if (indicator && before && after && after.width > 0) {
    const dx = before.left - after.left;
    const sx = before.width / after.width;
    indicator.animate(
      [{ transformOrigin: "left center", transform: `translateX(${dx}px) scaleX(${sx})` }, { transformOrigin: "left center", transform: "none" }],
      { duration: motionMs("--motion-page", 480), easing },
    );
  }
}
