import { Extension, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin } from "@tiptap/pm/state";
import { Markdown } from "tiptap-markdown";
import { HorizontalRuleOutsideTables, markdownTableExtensions } from "./RichTextEditorTable";
import { createEditorBlockExtensions } from "./editorBlocks/editorBlockExtensions";

/**
 * Tab and Shift-Tab nest and lift list items, move between table cells and pick
 * from the /, [[ and @ menus. At a caret anywhere else the browser would move
 * focus away from the text, so hold Tab there. Over selected text and task
 * checkboxes, leave the browser's focus order in place. Escape releases the
 * next Tab in either direction, including inside a list or table. Priority 1
 * lets the menus handle Escape first. Tiptap treats 0 as the default priority.
 */
const KeepTabInNote = Extension.create<{ onTabBlocked?: () => void }>({
  name: "keepTabInNote",
  priority: 1,
  addProseMirrorPlugins(): Plugin[] {
    let releaseNextTab = false;
    const reset = (): false => {
      releaseNextTab = false;
      return false;
    };
    const isTab = (event: KeyboardEvent): boolean =>
      event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey;

    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            keydown: (view, event): boolean => {
              if (event.key === "Shift" || (event.key === "Escape" && event.repeat)) return false;
              const release = releaseNextTab && view.hasFocus() && isTab(event);
              reset();
              // Skip ProseMirror's keymaps without preventing native focus traversal.
              return release;
            },
            blur: reset,
            mousedown: reset,
          },
          handleKeyDown: (view, event): boolean => {
            // Only the editing surface itself owns these shortcuts.
            if (!view.hasFocus()) return false;
            if (
              event.key === "Escape" &&
              !event.repeat &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey
            ) {
              releaseNextTab = true;
            }
            if (!isTab(event) || !view.state.selection.empty) return false;
            this.options.onTabBlocked?.();
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * The note editor's schema and Markdown round-trip. Order matters: at equal
 * priority Tiptap runs later extensions' plugins first, and the table's Enter
 * handling and clipboard serializer must win over StarterKit's and
 * tiptap-markdown's.
 */
export function createRichTextExtensions(
  placeholder: string,
  onTabBlocked?: () => void
): Extensions {
  return [
    StarterKit.configure({
      // The editor-block extensions replace these three with Markdown-aware versions
      // (alignment, syntax colours); see createEditorBlockExtensions.
      paragraph: false,
      heading: false,
      codeBlock: false,
      bulletList: { keepMarks: true },
      orderedList: { keepMarks: true },
      horizontalRule: false,
    }),
    HorizontalRuleOutsideTables,
    TaskList,
    TaskItem.configure({ nested: true }),
    ...createEditorBlockExtensions(),
    Placeholder.configure({
      placeholder,
      emptyEditorClass: "is-editor-empty",
    }),
    Markdown.configure({
      html: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    ...markdownTableExtensions,
    KeepTabInNote.configure({ onTabBlocked }),
  ];
}
