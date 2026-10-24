// The ten forge themes (CSS variables live in themes.css, copied from forge @ 0bee37f).
// Swatch = the theme's bg, fg and accent, shown in the theme picker.

export interface ThemeInfo {
  id: string;
  name: string;
  swatch: [string, string, string];
}

export const THEMES: readonly ThemeInfo[] = [
  { id: "carbon", name: "Carbon", swatch: ["#050505", "#e5e5e5", "#f5c518"] },
  { id: "tokyo-night", name: "Tokyo Night", swatch: ["#1a1b26", "#c0caf5", "#7aa2f7"] },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", swatch: ["#1e1e2e", "#cdd6f4", "#cba6f7"] },
  { id: "catppuccin-latte", name: "Catppuccin Latte", swatch: ["#eff1f5", "#4c4f69", "#7113ec"] },
  { id: "gruvbox", name: "Gruvbox", swatch: ["#282828", "#ebdbb2", "#fe8019"] },
  { id: "nord", name: "Nord", swatch: ["#2e3440", "#eceff4", "#8fc4d3"] },
  { id: "everforest", name: "Everforest", swatch: ["#2d353b", "#d3c6aa", "#a7c080"] },
  { id: "kanagawa", name: "Kanagawa", swatch: ["#1f1f28", "#dcd7ba", "#86a2da"] },
  { id: "rose-pine", name: "Rosé Pine", swatch: ["#191724", "#e0def4", "#c4a7e7"] },
  { id: "matte-black", name: "Matte Black", swatch: ["#121212", "#bebebe", "#e8a838"] },
];

export const DEFAULT_THEME = "carbon";
const THEME_KEY = "atlassian-notes.theme";

export function isThemeId(id: unknown): id is string {
  return typeof id === "string" && THEMES.some((t) => t.id === id);
}

export function currentTheme(): string {
  const id = document.documentElement.dataset.theme;
  return isThemeId(id) ? id : DEFAULT_THEME;
}

/** Sets data-theme on <html>; the theme's own `color-scheme` comes with its CSS block. */
export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = isThemeId(id) ? id : DEFAULT_THEME;
}

/** Applies the theme saved in this browser (invalid or missing → carbon). */
export function applySavedTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // storage unavailable
  }
  applyTheme(saved ?? DEFAULT_THEME);
}

export function saveTheme(id: string): void {
  applyTheme(id);
  try {
    localStorage.setItem(THEME_KEY, currentTheme());
  } catch {
    // storage unavailable
  }
}
