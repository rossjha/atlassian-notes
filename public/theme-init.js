// Applies the saved theme before the stylesheet paints, so a non-default theme never flashes Carbon.
// Keep the key and ids in sync with src/web/themes.ts (THEME_KEY, THEMES); src/web/main.ts re-applies it as a fallback.
(function () {
  var ids = ["carbon", "tokyo-night", "catppuccin-mocha", "catppuccin-latte", "gruvbox", "nord", "everforest", "kanagawa", "rose-pine", "matte-black"];
  try {
    var saved = localStorage.getItem("atlassian-notes.theme");
    if (saved && ids.indexOf(saved) !== -1) document.documentElement.dataset.theme = saved;
  } catch (e) {
    // storage unavailable: Carbon (the :root default) applies
  }
})();
