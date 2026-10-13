import { useEffect, useRef, useCallback, type MutableRefObject } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { cn } from "../lib/utils";
import { createMentionExtension } from "./RichTextEditorMention";
import { createRichTextExtensions } from "./RichTextEditorExtensions";
import { RichTextEditorFormatMenu } from "./RichTextEditorFormatMenu";
import { RichTextEditorTableMenu } from "./RichTextEditorTableMenu";
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

/**
 * Starts a new undo history. Earlier steps would otherwise be mapped onto a
 * value set from outside: one that spanned the whole document (select all,
 * then type or delete) maps onto the whole new value, so Ctrl+Z would put the
 * user's older text back over it and save that.
 */
function resetUndoHistory(editor: Editor): void {
  const { plugins } = editor.state;
  editor.unregisterPlugin("history");
  // Reconfiguring keeps every other plugin's state; the history starts empty.
  editor.view.updateState(editor.state.reconfigure({ plugins }));
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
      ...createRichTextExtensions(placeholder || ""),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor: ed, transaction }) => {
      // A plugin's appended change (the trailing paragraph after a list, added
      // on the first click) is not an edit; saving it would also discard the
      // assistant's Undo for the note.
      if (suppressUpdateRef.current || !transaction.docChanged) return;

      const md = (ed.storage as any).markdown.getMarkdown() as string;
      internalValueRef.current = md;
      onChange?.(md);
    },
    editorProps: {
      attributes: {
        class: "rich-text-editor-content",
        dir: "auto",
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
    // A whitespace-only note is saved empty; that echo is not a new value, and
    // applying it would move the caret.
    if (value === internalValueRef.current || (!value && !internalValueRef.current.trim())) return;

    internalValueRef.current = value;
    suppressUpdateRef.current = true;

    const { from, to } = editor.state.selection;
    editor.commands.setContent(value);

    // Restore cursor position within bounds
    const docSize = editor.state.doc.content.size;
    const safeFrom = Math.min(from, docSize);
    const safeTo = Math.min(to, docSize);
    editor.commands.setTextSelection({ from: safeFrom, to: safeTo });
    resetUndoHistory(editor);

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
          // relative: the table menu positions against this scroller and scrolls with it.
          "relative h-full overflow-y-auto",
          disabled && "pointer-events-none opacity-70",
          // Reserved by an ancestor via --floating-inset; 0 elsewhere.
          "pb-[var(--floating-inset,0px)]"
        )}
      />
      {editor && !disabled && <RichTextEditorFormatMenu editor={editor} />}
      {editor && !disabled && <RichTextEditorTableMenu editor={editor} />}
    </div>
  );
}
