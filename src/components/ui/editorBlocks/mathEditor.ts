/**
 * small inline editor for a math formula (Electron has no
 * window.prompt). Opens under the formula; Enter saves, Escape cancels, an
 * empty formula deletes it.
 */
import type { Editor } from "@tiptap/core";
import { tb } from "./translate";

export function editLatex(editor: Editor, node: any, pos: number) {
  if (!editor.isEditable) return;
  document.querySelector(".rte-inline-input")?.remove();

  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  const rect = dom?.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "rte-inline-input";
  box.style.position = "fixed";
  box.style.zIndex = "9999";
  box.style.left = `${Math.max(8, rect?.left ?? 100)}px`;
  box.style.top = `${(rect?.bottom ?? 100) + 6}px`;

  const input = document.createElement("input");
  input.type = "text";
  input.dir = "ltr"; // LaTeX source is always left-to-right
  input.value = node.attrs.latex ?? "";
  input.placeholder = tb("prompt.latexInline");
  input.spellcheck = false;
  box.appendChild(input);

  const hint = document.createElement("div");
  hint.className = "rte-inline-input-hint";
  hint.textContent = tb("prompt.mathEdit");
  box.appendChild(hint);
  document.body.appendChild(box);

  const finish = (save: boolean) => {
    box.remove();
    if (!save) return editor.commands.focus();
    const latex = input.value.trim();
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== node.type.name) return;
    const tr = latex
      ? editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex })
      : editor.state.tr.delete(pos, pos + current.nodeSize);
    editor.view.dispatch(tr);
    editor.commands.focus();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => box.isConnected && finish(true), 0));
  setTimeout(() => input.focus(), 0);
}
