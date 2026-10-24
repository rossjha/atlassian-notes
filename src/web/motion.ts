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
 * Runs `update` (synchronous DOM work) inside a view transition when the browser supports it and motion is allowed;
 * otherwise runs it at once. `dir` lands on <html data-nav-dir> for the page-slide CSS.
 */
export function withPageTransition(dir: NavDir | null, update: () => void): void {
  const start = (document as { startViewTransition?: StartViewTransition }).startViewTransition;
  if (!dir || typeof start !== "function" || !motionAllowed()) {
    update();
    return;
  }
  document.documentElement.dataset.navDir = dir;
  start.call(document, update);
}
