// Bundled by scripts/build-scratchpad.ts (esbuild) into public/vendor/; loaded only when the Scratchpad tab opens.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, hashElementsVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

export type ScratchTheme = "light" | "dark";

export interface ScratchpadHandle {
  setTheme(theme: ScratchTheme): void;
  /** The current scene as .excalidraw JSON, or null before Excalidraw is ready. */
  serialize(): string | null;
  /**
   * Changes whenever the drawing does (deleted elements count, so erasing does too), but not on load-time
   * tidying or on panning/zooming/selection. Null before Excalidraw is ready.
   */
  version(): string | null;
  unmount(): void;
}

/**
 * Mounts Excalidraw into `el`. `scene` is a parsed .excalidraw file (or null for a blank canvas);
 * `onChange` fires on every scene change (pointer moves included), so callers debounce.
 */
export function mountScratchpad(
  el: HTMLElement,
  opts: { scene: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> } | null; theme: ScratchTheme; onChange: () => void },
): ScratchpadHandle {
  const root = createRoot(el);
  let api: ExcalidrawImperativeAPI | null = null;
  const initialData = opts.scene
    ? { elements: opts.scene.elements ?? [], appState: opts.scene.appState ?? {}, files: opts.scene.files ?? {}, scrollToContent: true }
    : null;
  const render = (theme: ScratchTheme): void => {
    root.render(createElement(Excalidraw, {
      // Excalidraw's own types for initialData are stricter than a file read back from disk; it restores it itself.
      initialData: initialData as never,
      theme,
      aiEnabled: false,
      excalidrawAPI: (a: ExcalidrawImperativeAPI) => {
        api = a;
      },
      onChange: () => opts.onChange(),
      UIOptions: { canvasActions: { toggleTheme: false } },
    }));
  };
  render(opts.theme);
  return {
    setTheme: render,
    serialize: () => (api ? serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local") : null),
    version: () =>
      api
        ? `${hashElementsVersion(api.getSceneElementsIncludingDeleted())}:${api.getAppState().viewBackgroundColor}:${Object.keys(api.getFiles()).length}`
        : null,
    unmount: () => root.unmount(),
  };
}
