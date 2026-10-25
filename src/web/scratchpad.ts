import { h } from "./dom.ts";

/** The Excalidraw bundle's API (src/scratchpad/entry.ts, built into public/vendor/). */
type ScratchTheme = "light" | "dark";
interface ScratchpadHandle {
  setTheme(theme: ScratchTheme): void;
  serialize(): string | null;
  version(): string | null;
  unmount(): void;
}
interface ScratchpadModule {
  mountScratchpad(el: HTMLElement, opts: { scene: unknown; theme: ScratchTheme; onChange: () => void }): ScratchpadHandle;
}

const BUNDLE = "/vendor/scratchpad.js";
const SAVE_DEBOUNCE_MS = 800;

let handle: ScratchpadHandle | null = null;
let mounting: Promise<void> | null = null;
/**
 * The drawing's version (see the bundle's version()) as last loaded or saved. The first change event after
 * mount sets it, so Excalidraw tidying a scene on load never rewrites the file; only real edits are saved.
 */
let lastSaved: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
/** Set when the file on disk couldn't be read: the canvas is shown but never saved over it. */
let readOnly = false;
let statusEl: HTMLElement | null = null;

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

/** The app themes are all dark except the light ones, which set `color-scheme: light`. */
function appTheme(): ScratchTheme {
  return getComputedStyle(document.documentElement).colorScheme.includes("light") ? "light" : "dark";
}

function setStatus(text: string, isError = false): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle("scratch-status-error", isError);
}

async function save(): Promise<void> {
  if (!handle || readOnly) return;
  const version = handle.version();
  const json = handle.serialize();
  if (json === null || version === null || version === lastSaved) return;
  setStatus("Saving…");
  try {
    const res = await fetch("/api/scratchpad", { method: "PUT", headers: { "Content-Type": "application/json" }, body: json });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `${res.status} ${res.statusText}`);
    }
    lastSaved = version;
    setStatus("Saved");
  } catch (e) {
    setStatus(`Not saved: ${(e as Error).message}`, true);
  }
}

/** Saves now if anything changed (queued behind any save in flight). */
export function flushScratchpad(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  saving = saving.then(save);
  return saving;
}

function onSceneChange(): void {
  if (readOnly || !handle) return;
  const version = handle.version();
  if (version === null) return;
  if (lastSaved === null) {
    lastSaved = version; // the scene as loaded
    return;
  }
  if (version !== lastSaved) scheduleSave();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushScratchpad(), SAVE_DEBOUNCE_MS);
}

/** Mounts Excalidraw into `host` once (later calls keep the live canvas, undo history included). */
export function showScratchpad(host: HTMLElement): Promise<void> {
  if (mounting) return mounting;
  mounting = (async () => {
    statusEl = h("span", { class: "text-muted scratch-status" }, "Loading…");
    const canvas = h("div", { class: "scratch-canvas" });
    host.replaceChildren(h("div", { class: "scratch-bar" }, h("span", { class: "text-muted" }, "Saved to scratchpad.excalidraw in your notes folder"), statusEl), canvas);
    try {
      // Fonts are served next to the bundle, never from a CDN.
      window.EXCALIDRAW_ASSET_PATH = "/vendor/";
      if (!document.querySelector("link[data-scratchpad]")) {
        document.head.append(h("link", { rel: "stylesheet", href: "/vendor/scratchpad.css", "data-scratchpad": "" }));
      }
      const [mod, data] = await Promise.all([
        import(BUNDLE) as Promise<ScratchpadModule>,
        fetch("/api/scratchpad").then((r) => r.json() as Promise<{ scene: unknown; error: string | null }>),
      ]);
      readOnly = data.error !== null;
      handle = mod.mountScratchpad(canvas, { scene: data.scene, theme: appTheme(), onChange: onSceneChange });
      setStatus(readOnly ? `${data.error} (changes here are not saved)` : data.scene ? "Saved" : "New scratchpad", readOnly);
      new MutationObserver(() => handle?.setTheme(appTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      window.addEventListener("pagehide", () => void flushScratchpad());
    } catch (e) {
      mounting = null;
      setStatus(`Could not load the scratchpad: ${(e as Error).message}`, true);
    }
  })();
  return mounting;
}
