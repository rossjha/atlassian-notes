// ⌘K / Ctrl+K command palette: a modal dialog with a search box over grouped commands (matching in src/shared/palette.ts).
import { filterPalette, type PaletteCommand } from "../shared/palette.ts";
import { h } from "./dom.ts";
import { icon } from "./icons.ts";

let open: HTMLDialogElement | null = null;

/** Wires up ⌘K. `getCommands` is asked afresh on open and on every keystroke, so it can offer query-specific commands. */
export function initPalette(getCommands: (query: string) => PaletteCommand[]): void {
  // Capture phase, so the palette also opens while Excalidraw (which binds ⌘K to "add link") has focus.
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (open) {
      e.preventDefault();
      e.stopPropagation();
      open.close();
      return;
    }
    if (document.querySelector("dialog[open]")) return; // another modal (confirm, view editor) keeps the keyboard
    e.preventDefault();
    e.stopPropagation();
    showPalette(getCommands);
  }, true);
}

function showPalette(getCommands: (query: string) => PaletteCommand[]): void {
  const input = h("input", {
    type: "text",
    class: "palette-input",
    placeholder: "Type a command or a ticket key…",
    role: "combobox",
    "aria-label": "Command",
    "aria-autocomplete": "list",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const list = h("div", { class: "palette-list", id: "palette-list", role: "listbox", "aria-label": "Commands" });
  const dialog = h("dialog", { class: "palette-dialog", "aria-label": "Command palette" },
    h("label", { class: "palette-field" }, icon("magnifyingGlass", "palette-icon"), input),
    list,
  ) as HTMLDialogElement;

  let shown: { cmd: PaletteCommand; el: HTMLElement }[] = [];
  let active = 0;
  let chosen: PaletteCommand | null = null;

  const setActive = (i: number) => {
    if (shown.length === 0) return;
    active = (i + shown.length) % shown.length;
    shown.forEach((s, j) => s.el.setAttribute("aria-selected", String(j === active)));
    input.setAttribute("aria-activedescendant", shown[active]!.el.id);
    shown[active]!.el.scrollIntoView({ block: "nearest" });
  };
  const choose = (cmd: PaletteCommand) => {
    chosen = cmd;
    dialog.close();
  };

  const render = () => {
    const groups = filterPalette(getCommands(input.value), input.value);
    shown = [];
    list.replaceChildren(...groups.map((g, gi) => {
      const headingId = `palette-g${gi}`;
      return h("div", { role: "group", class: "palette-group", "aria-labelledby": headingId },
        h("div", { class: "palette-heading", id: headingId }, g.heading),
        ...g.items.map((cmd) => {
          const i = shown.length;
          const el = h("div", {
            role: "option",
            id: `palette-o${i}`,
            class: "palette-item",
            "aria-selected": "false",
            onmousedown: (e) => e.preventDefault(), // keep focus in the search box
            onmousemove: () => {
              if (active !== i) setActive(i);
            },
            onclick: () => choose(cmd),
          },
            h("span", { class: "palette-label" }, cmd.label),
            cmd.current ? h("span", { class: "palette-current", "aria-label": "(current)" }, "●") : null,
            cmd.hint ? h("kbd", { class: "palette-kbd" }, cmd.hint) : null,
          );
          shown.push({ cmd, el });
          return el;
        }),
      );
    }));
    if (shown.length === 0) {
      list.append(h("p", { class: "palette-empty" }, "No matching commands"));
      input.removeAttribute("aria-activedescendant");
    } else setActive(0);
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const s = shown[active];
      if (s) choose(s.cmd);
    }
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    open = null;
    // The dialog has handed focus back by now, so a command that moves focus (e.g. Edit JQL) keeps it.
    chosen?.run();
  });

  render();
  document.body.append(dialog);
  open = dialog;
  dialog.showModal();
  input.focus();
}
