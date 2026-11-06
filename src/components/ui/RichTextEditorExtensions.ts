import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { HorizontalRuleOutsideTables, markdownTableExtensions } from "./RichTextEditorTable";
import { createEditorBlockExtensions } from "./editorBlocks/editorBlockExtensions";

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
  ];
}
