import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { AppFont } from '@/lib/fonts';
import { useTheme } from '../ThemeProvider';
import { applyFormat } from './formatText';
import { LiveMarkdown, NotesReadView } from './liveMarkdown';
import { toggleCheck } from './liveMarkdownSpans';
import { notesT } from './strings';

export type FormatKind = 'bold' | 'italic' | 'bullet' | 'check' | 'heading';
export type SummaryEditorHandle = { format: (kind: FormatKind) => void; blur: () => void };

/**
 * The AI Summary, edited the way the Notes tab is (Josh, 23 Nov): formatted text until you tap a
 * line, then the same live-formatted field with the format bar and Done above the keyboard (the
 * screen draws the bar from `onFocusChange`). The caller owns saving. As before, new saved text
 * (regenerated or synced) replaces the draft until you type into it, an AI action taking over
 * ends the edit, and leaving mid-edit reports the edit as over so the caller flushes its save.
 */
export const SummaryEditor = forwardRef<
  SummaryEditorHandle,
  {
    content: string;
    editable: boolean;
    onChange: (text: string) => void;
    onEditingChange: (editing: boolean) => void;
    onFocusChange: (focused: boolean) => void;
  }
>(function SummaryEditor({ content, editable, onChange, onEditingChange, onFocusChange }, ref) {
  const k = useTheme().tokens;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [selection, setSelection] = useState({ start: content.length, end: content.length });
  const input = useRef<TextInput>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const draftEdited = useRef(false);
  const callbacks = useRef({ onEditingChange, onFocusChange });
  callbacks.current = { onEditingChange, onFocusChange };

  const setEditingState = (next: boolean) => {
    if (next) draftEdited.current = false;
    setEditing(next);
    callbacks.current.onEditingChange(next);
  };
  const change = (text: string) => {
    draftEdited.current = true;
    setDraft(text);
    onChange(text);
  };

  useEffect(() => {
    if (!editingRef.current || !draftEdited.current) setDraft(content);
  }, [content]);
  useEffect(() => {
    if (!editable && editingRef.current) {
      input.current?.blur();
      setEditingState(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);
  useEffect(
    () => () => {
      if (editingRef.current) callbacks.current.onEditingChange(false);
      callbacks.current.onFocusChange(false);
    },
    [],
  );

  useImperativeHandle(ref, () => ({
    format: (kind) => {
      const result = applyFormat(draftRef.current, selectionRef.current, kind);
      change(result.text);
      // As on the Notes tab: the caret goes between the new marks a frame later.
      requestAnimationFrame(() => setSelection({ start: result.caret, end: result.caret }));
    },
    blur: () => input.current?.blur(),
  }));

  if (!editing && draft.trim())
    return (
      // A plain container: each line sets the caret where it was tapped (a press handler here
      // would take the tap and put the caret at the end).
      <View testID="enhanced-read">
        <NotesReadView
          text={draft}
          editable={editable}
          onEdit={(caret) => {
            setSelection({ start: caret, end: caret });
            setEditingState(true);
          }}
          onToggle={(line) => change(toggleCheck(draft, line))}
        />
      </View>
    );
  return (
    <TextInput
      ref={input}
      testID="enhanced-editor"
      onChangeText={change}
      selection={selection}
      onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
      autoFocus={editing}
      onFocus={() => {
        if (!editingRef.current) setEditingState(true);
        callbacks.current.onFocusChange(true);
      }}
      onBlur={() => {
        callbacks.current.onFocusChange(false);
        setEditingState(false);
      }}
      placeholder={notesT('summaryPlaceholder')}
      placeholderTextColor={k.tertiary}
      selectionColor={k.selFill}
      selectionHandleColor={k.accent}
      cursorColor={k.accent}
      multiline
      editable={editable}
      textAlignVertical="top"
      style={{
        minHeight: 160,
        fontFamily: AppFont.regular,
        fontSize: 16,
        lineHeight: 26,
        color: k.ink,
        padding: 0,
      }}
    >
      <LiveMarkdown text={draft} caret={selection.end} />
    </TextInput>
  );
});
