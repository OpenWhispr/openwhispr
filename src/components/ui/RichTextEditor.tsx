import { useEffect, useRef, useCallback, useState, type MutableRefObject } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { cn } from "../lib/utils";
import { createMentionExtension } from "./RichTextEditorMention";
import { createRichTextExtensions } from "./RichTextEditorExtensions";
import { RichTextEditorFormatMenu } from "./RichTextEditorFormatMenu";
import { RichTextEditorTableMenu } from "./RichTextEditorTableMenu";
import type { MentionPerson } from "../../utils/mentionMarkdown";

/**
 * ProseMirror's scroll margin or threshold (`side` on every side), raised at the
 * bottom to whatever an ancestor overlays there: NoteBottomBar publishes its height
 * in --bottom-overlay-height. ProseMirror reads the sides each time it scrolls the
 * caret into view, so the getter follows the bar as it grows (action chips, the
 * summary callout, an open chat).
 */
function clearOfBottomOverlay(
  getContainer: () => HTMLElement | null,
  side: number
): Record<"top" | "right" | "bottom" | "left", number> {
  return {
    top: side,
    right: side,
    left: side,
    get bottom(): number {
      const container = getContainer();
      const overlay = container
        ? parseFloat(getComputedStyle(container).getPropertyValue("--bottom-overlay-height"))
        : NaN;
      return Number.isFinite(overlay) ? Math.max(overlay, side) : side;
    },
  };
}

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

  const containerRef = useRef<HTMLDivElement>(null);
  // Without this, a new line at the end of a long note scrolls only 5px clear of
  // the bottom edge, under the note's bottom bar.
  const [scrollClearance] = useState(() => ({
    scrollMargin: clearOfBottomOverlay(() => containerRef.current, 5),
    scrollThreshold: clearOfBottomOverlay(() => containerRef.current, 0),
  }));

  const editor = useEditor({
    extensions: [
      ...(withMentions ? [createMentionExtension(() => mentionPeopleRef.current ?? [])] : []),
      ...createRichTextExtensions(placeholder || ""),
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
        dir: "auto",
      },
      ...scrollClearance,
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
    <div
      ref={containerRef}
      className={cn("relative w-full h-full", className)}
      onClick={handleClick}
    >
      <EditorContent
        editor={editor}
        className={cn(
          // relative: the table menu positions against this scroller and scrolls with it.
          "relative h-full overflow-y-auto",
          disabled && "pointer-events-none opacity-70"
        )}
      />
      {editor && !disabled && <RichTextEditorFormatMenu editor={editor} />}
      {editor && !disabled && <RichTextEditorTableMenu editor={editor} />}
    </div>
  );
}
