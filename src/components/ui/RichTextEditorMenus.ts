import { useEffect, useMemo, useRef, useState } from "react";
import type { ChainedCommands, Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import type { BubbleMenuProps } from "@tiptap/react/menus";

// Shared by the note editor's floating menus (Tiptap BubbleMenu and FloatingMenu).

export type ChainCommand = (chain: ChainedCommands) => ChainedCommands;

/** Runs a command on the editor, which keeps the focus its menu button took. */
export const runCommand = (editor: Editor, command: ChainCommand) =>
  command(editor.chain().focus()).run();

/** Focus is in the editor or in a menu attached to it: the menus live in the editor's scroller. */
export const editorHasFocus = (view: EditorView) =>
  !!view.dom.parentElement?.contains(document.activeElement);

/**
 * Tiptap re-checks a menu only on editor changes and when the editor blurs, and a
 * click in a menu swallows the editor's next blur. So hide the menus whenever
 * focus leaves the editor and them, including from inside one (Tab).
 */
export function useHideOnFocusLeave(editor: Editor, pluginKeys: readonly string[]) {
  useEffect(() => {
    const scroller = editor.view.dom.parentElement;
    if (!scroller) return;
    const onFocusOut = (event: FocusEvent) => {
      // Switching windows leaves focus where it was, for when the window comes back.
      if (!document.hasFocus() || scroller.contains(event.relatedTarget as Node | null)) return;
      const target = event.target as Element;
      // An open dropdown holds on to focus (a dialog opened over it hands it back)
      // and returns it to the editor when it closes.
      if (target.closest('[role="menu"]')) return;
      // Chromium also fires focusout while it removes a focused element, before
      // detaching it. Whatever removes it (Tiptap hiding a menu) handles focus,
      // and a hide from here would interrupt that removal.
      queueMicrotask(() => {
        if (editor.isDestroyed || !target.isConnected) return;
        const tr = editor.state.tr;
        for (const key of pluginKeys) tr.setMeta(key, "hide");
        editor.view.dispatch(tr);
      });
    };
    scroller.addEventListener("focusout", onFocusOut);
    return () => scroller.removeEventListener("focusout", onFocusOut);
  }, [editor, pluginKeys]);
}

/**
 * A dropdown inside a menu, portaled into the menu element itself. Not into the
 * editor's scroller: EditorContent moves that element's children when a note
 * closes, and React could then no longer remove an open dropdown.
 *
 * Tiptap detaches that element to hide the menu without React unmounting what's
 * inside it, which would leave the dropdown open over a scroll-locked page. So
 * the dropdown is controlled and closes with the menu.
 */
export function useMenuDropdown(menuOptions?: BubbleMenuProps["options"]) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setContainer(menuRef.current), []);
  // Stable: a menu dispatches a transaction whenever its props change.
  const options = useMemo(() => ({ ...menuOptions, onHide: () => setOpen(false) }), [menuOptions]);
  return { menuRef, container, open, setOpen, options };
}

/** Restore focus only while the note is still editable and mounted. */
export const refocusEditor =
  (editor: Editor): ((event: Event) => void) =>
  (event: Event): void => {
    event.preventDefault();
    if (!editor.isDestroyed && editor.isEditable) editor.commands.focus();
  };
