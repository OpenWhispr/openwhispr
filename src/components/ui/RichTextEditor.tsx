import { useEffect, useRef, useCallback, type MutableRefObject } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { cn } from "../lib/utils";
import { createMentionExtension } from "./RichTextEditorMention";
import type { MentionPerson } from "../../utils/mentionMarkdown";

interface RichTextEditorProps {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  editorRef?: MutableRefObject<Editor | null>;
  /** Enables @mention tagging with these people as suggestions. */
  mentionPeople?: MentionPerson[];
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  className,
  disabled,
  editorRef,
  mentionPeople,
}: RichTextEditorProps) {
  const internalValueRef = useRef(value);
  const suppressUpdateRef = useRef(false);

  // Mention support is decided at mount; the ref keeps suggestions current
  // without rebuilding the editor when the people list changes.
  const mentionPeopleRef = useRef(mentionPeople);
  useEffect(() => {
    mentionPeopleRef.current = mentionPeople;
  }, [mentionPeople]);
  const withMentions = useRef(mentionPeople != null).current;

  const editor = useEditor({
    extensions: [
      ...(withMentions ? [createMentionExtension(() => mentionPeopleRef.current ?? [])] : []),
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: placeholder || "",
        emptyEditorClass: "is-editor-empty",
      }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor: ed }) => {
      if (suppressUpdateRef.current) return;

      const md = (ed.storage as any).markdown.getMarkdown() as string;
      internalValueRef.current = md;
      onChange?.(md);
    },
    editorProps: {
      attributes: {
        class: "rich-text-editor-content",
      },
    },
  });

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
    return () => {
      if (editorRef) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // Sync external value changes (e.g. dictation, programmatic updates)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === internalValueRef.current) return;

    internalValueRef.current = value;
    suppressUpdateRef.current = true;

    const { from, to } = editor.state.selection;
    editor.commands.setContent(value);

    // Restore cursor position within bounds
    const docSize = editor.state.doc.content.size;
    const safeFrom = Math.min(from, docSize);
    const safeTo = Math.min(to, docSize);
    editor.commands.setTextSelection({ from: safeFrom, to: safeTo });

    suppressUpdateRef.current = false;
  }, [value, editor]);

  // Sync editable state
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.setEditable(!disabled, false);
    }
  }, [disabled, editor]);

  const handleClick = useCallback(() => {
    if (editor && !editor.isFocused && !disabled) {
      editor.commands.focus();
    }
  }, [editor, disabled]);

  return (
    <div className={cn("relative w-full h-full", className)} onClick={handleClick}>
      <EditorContent
        editor={editor}
        className={cn(
          "h-full overflow-y-auto",
          disabled && "pointer-events-none opacity-70",
          // Reserved by an ancestor via --floating-inset; 0 elsewhere.
          "pb-[var(--floating-inset,0px)]"
        )}
      />
    </div>
  );
}
