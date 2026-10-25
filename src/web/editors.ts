import type { CustomColumnDef, NoteFile, Row } from "../shared/types.ts";
import { api, type SaveResult } from "./api.ts";
import { h } from "./dom.ts";

let openCount = 0;
let idleListener: (() => void) | null = null;

/** True while any inline editor is open; callers must not rebuild the DOM under it. */
export function isEditing(): boolean {
  return openCount > 0;
}

/** Called once the last open editor closes (used to apply deferred re-renders). */
export function onEditorsIdle(cb: () => void): void {
  idleListener = cb;
}

function begin(onDone: () => void): () => void {
  openCount++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openCount--;
    onDone();
    if (openCount === 0) idleListener?.();
  };
}

export interface NoteEditorOptions {
  rows?: number;
}

/** Something with a markdown body that an inline editor can save (a ticket note, a reading item's note). */
export interface EditableDoc {
  label: string;
  note: { body: string; mtimeMs: number } | null;
  save(body: string, baseMtimeMs: number | null, force: boolean): Promise<SaveResult>;
}

export function editNote(cell: HTMLElement, row: Row, onDone: () => void, options: NoteEditorOptions = {}): void {
  const doc: EditableDoc = {
    label: `Note for ${row.ticket.key}`,
    get note() {
      return row.note;
    },
    async save(body, base, force) {
      const result = await api.saveNote(row.ticket.key, body, base, force);
      if (result.kind === "ok") row.note = { body, mtimeMs: result.mtimeMs };
      return result;
    },
  };
  editMarkdown(cell, doc, onDone, options);
}

export function editMarkdown(cell: HTMLElement, doc: EditableDoc, onDone: () => void, options: NoteEditorOptions = {}): void {
  const close = begin(onDone);
  let original = doc.note?.body ?? "";
  let baseMtimeMs: number | null = doc.note?.mtimeMs ?? null;
  let saving = false;
  let finished = false;

  const area = h("textarea", { class: "editor-area", rows: String(options.rows ?? 4), "aria-label": doc.label }) as HTMLTextAreaElement;
  area.value = original;
  const message = h("div", { class: "editor-msg", role: "alert" });
  message.hidden = true;
  const actions = h("div", { class: "editor-actions" });
  actions.hidden = true;
  cell.replaceChildren(h("div", { class: "editor-wrap" }, area, message, actions));

  const showMessage = (text: string, withActions: NoteFile | null): void => {
    message.textContent = text;
    message.hidden = false;
    actions.replaceChildren();
    actions.hidden = withActions === null;
    if (withActions) {
      const current = withActions;
      actions.append(
        h("button", { type: "button", class: "btn", onclick: () => {
          area.value = current.body;
          original = current.body;
          baseMtimeMs = current.mtimeMs;
          message.hidden = true;
          actions.hidden = true;
          area.focus();
        } }, "Reload theirs"),
        h("button", { type: "button", class: "btn", onclick: () => { baseMtimeMs = current.mtimeMs; void save(true); } }, "Overwrite"),
      );
    }
  };

  async function save(force = false): Promise<void> {
    if (saving || finished) return;
    saving = true;
    const text = area.value;
    let result: SaveResult;
    try {
      result = await doc.save(text, baseMtimeMs, force);
    } catch (e) {
      saving = false;
      showMessage((e as Error).message, null);
      return;
    }
    saving = false;
    if (result.kind === "ok") {
      baseMtimeMs = result.mtimeMs;
      original = text;
      message.hidden = true;
      actions.hidden = true;
      if (area.value !== text) {
        // Typed while the save was in flight: keep the editor open so nothing is lost.
        // If focus already left (that blur was ignored while saving), save the rest now.
        if (document.activeElement !== area) void save();
        return;
      }
      finished = true;
      close();
    } else if (result.kind === "conflict") {
      showMessage("Changed on disk since you opened it", result.current);
    } else {
      showMessage(result.error, null);
    }
  }

  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finished = true;
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  });
  area.addEventListener("blur", () => {
    if (finished || saving) return;
    // Focus moving to the conflict buttons must not trigger another save.
    if (!actions.hidden) return;
    if (area.value !== original) void save();
    else {
      finished = true;
      close();
    }
  });
  area.focus();
}

export function editCustom(cell: HTMLElement, row: Row, colId: string, def: CustomColumnDef, onDone: () => void): void {
  const close = begin(onDone);
  const original = row.custom[colId] ?? "";
  let saving = false;
  let finished = false;
  const message = h("div", { class: "editor-msg", role: "alert" });
  message.hidden = true;

  const input: HTMLInputElement | HTMLSelectElement = def.type === "select"
    ? (h("select", { class: "editor-input", "aria-label": def.label },
        h("option", { value: "" }, "— none —"),
        ...Object.keys(def.options).map((o) => h("option", { value: o }, o)),
      ) as HTMLSelectElement)
    : (h("input", { class: "editor-input", type: "text", "aria-label": def.label }) as HTMLInputElement);
  input.value = original;
  cell.replaceChildren(h("div", { class: "editor-wrap" }, input, message));

  async function save(): Promise<void> {
    if (saving || finished) return;
    const value = input.value === "" ? null : input.value;
    if (input.value === original) {
      finished = true;
      close();
      return;
    }
    saving = true;
    try {
      const result = await api.setField(row.ticket.key, colId, value);
      saving = false;
      if (result.kind === "ok") {
        if (value === null) delete row.custom[colId];
        else row.custom[colId] = value;
        finished = true;
        close();
      } else {
        message.textContent = result.kind === "conflict" ? "Changed on disk since you opened it" : result.error;
        message.hidden = false;
      }
    } catch (e) {
      saving = false;
      message.textContent = (e as Error).message;
      message.hidden = false;
    }
  }

  input.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Escape") {
      ke.preventDefault();
      finished = true;
      close();
    } else if (ke.key === "Enter" && def.type === "text") {
      ke.preventDefault();
      void save();
    }
  });
  if (def.type === "select") input.addEventListener("change", () => void save());
  input.addEventListener("blur", () => {
    if (finished || saving) return;
    if (def.type === "text" && input.value !== original) void save();
    else {
      finished = true;
      close();
    }
  });
  input.focus();
  if (def.type === "select") {
    try {
      (input as HTMLSelectElement).showPicker();
    } catch {
      // picker needs a user gesture in some browsers; the focused select still works
    }
  }
}
