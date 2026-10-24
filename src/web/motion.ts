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
 * get the page slide from the Web Animations API: `pageEls` slide in from the side (the tab underline glides by its own
 * CSS transition). Element.animate() is not an inline style attribute, so CSP is unaffected.
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
  update();
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--motion-ease").trim() || "ease-out";
  // Tab switches use the slower page duration and a 48px travel so the slide is noticeable but still quick.
  const enter = motionMs("--motion-page", 480);
  const from = dir === "forward" ? "48px 0" : "-48px 0";
  for (const el of pageEls) {
    if (el.isConnected && !el.hidden) el.animate([{ opacity: 0, translate: from }, { opacity: 1, translate: "0 0" }], { duration: enter, easing });
  }
}
