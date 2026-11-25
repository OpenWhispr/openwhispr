import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { HorizontalRuleOutsideTables, markdownTableExtensions } from "./RichTextEditorTable";
import { createEditorBlockExtensions } from "./editorBlocks/editorBlockExtensions";

/**
 * Tab and Shift-Tab nest and lift list items, move between table cells and pick
 * from the /, [[ and @ menus. At a caret anywhere else the browser would move
 * focus away from the text, so they do nothing there. Over selected text, or
 * from a task checkbox, this leaves them to the browser's focus order, which
 * reaches the formatting toolbar after the text when one shows. Priority 1 runs
 * this after every other keymap; Tiptap reads 0 as the default, 100.
 */
const KeepTabInNote = Extension.create({
  name: "keepTabInNote",
  priority: 1,
  addKeyboardShortcuts() {
    // hasFocus: the text has focus, not a task checkbox inside it.
    const atCaret = () => this.editor.view.hasFocus() && this.editor.state.selection.empty;
    return { Tab: atCaret, "Shift-Tab": atCaret };
  },
});

/**
 * The note editor's schema and Markdown round-trip. Order matters: at equal
 * priority Tiptap runs later extensions' plugins first, and the table's Enter
 * handling and clipboard serializer must win over StarterKit's and
 * tiptap-markdown's.
 */
export function createRichTextExtensions(placeholder: string) {
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
    KeepTabInNote,
  ];
}
