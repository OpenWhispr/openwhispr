/**
 * one-line input shown at the caret (Electron has no
 * window.prompt). Resolves with the text, or null on Escape / empty.
 */
import type { Editor } from "@tiptap/core";
import { tb } from "./translate";

export function promptInline(
  editor: Editor,
  {
    placeholder,
    initial = "",
    hint = tb("prompt.apply"),
  }: { placeholder: string; initial?: string; hint?: string }
): Promise<string | null> {
  document.querySelector(".rte-inline-input")?.remove();
  const coords = editor.view.coordsAtPos(editor.state.selection.from);
  const box = document.createElement("div");
  box.className = "rte-inline-input";
  box.style.position = "fixed";
  box.style.zIndex = "9999";
  box.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 340))}px`;
  box.style.top = `${coords.bottom + 6}px`;
  const input = document.createElement("input");
  input.type = "text";
  input.dir = "auto"; // links, names, readings in any script
  input.value = initial;
  input.placeholder = placeholder;
  input.spellcheck = false;
  const help = document.createElement("div");
  help.className = "rte-inline-input-hint";
  help.textContent = hint;
  box.append(input, help);
  document.body.appendChild(box);

  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      box.remove();
      editor.commands.focus();
      resolve(value && value.trim() ? value.trim() : null);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    });
    input.addEventListener("blur", () => setTimeout(() => finish(null), 0));
    setTimeout(() => input.focus(), 0);
  });
}
