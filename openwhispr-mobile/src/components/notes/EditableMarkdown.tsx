import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { MarkdownRenderer } from './MarkdownRenderer';

interface EditableMarkdownProps {
  content: string;
  editable?: boolean;
  onChange: (text: string) => void;
  onEditingChange?: (editing: boolean) => void;
}

/** Rendered Markdown that swaps to its raw source for editing. The caller owns saving. */
export function EditableMarkdown({
  content,
  editable = true,
  onChange,
  onEditingChange,
}: EditableMarkdownProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Whether the open edit has changed the draft. Until it has, the draft follows the saved notes.
  const draftEditedRef = useRef(false);
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;

  const setEditingState = (next: boolean): void => {
    if (next) draftEditedRef.current = false;
    setEditing(next);
    onEditingChangeRef.current?.(next);
  };

  // New saved notes (regenerated or synced) replace the draft unless the user has typed into it.
  // Only a change to `content` does this: leaving editing keeps the draft until the caller's save
  // comes back.
  useEffect(() => {
    if (!editingRef.current || !draftEditedRef.current) setDraft(content);
  }, [content]);

  // An AI action taking over the notes ends the edit.
  useEffect(() => {
    if (!editable && editingRef.current) setEditingState(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  // Leaving the tab unmounts the editor mid-edit; report it so the caller flushes the save.
  useEffect(
    () => () => {
      if (editingRef.current) onEditingChangeRef.current?.(false);
    },
    [],
  );

  if (editing) {
    return (
      <View>
        <View className="mb-2 flex-row justify-end">
          <Pressable
            testID="enhanced-done"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => setEditingState(false)}
          >
            <Text className="text-[15px] font-semibold text-link">Done</Text>
          </Pressable>
        </View>
        <TextInput
          testID="enhanced-editor"
          accessibilityLabel="Enhanced notes"
          value={draft}
          onChangeText={(text) => {
            draftEditedRef.current = true;
            setDraft(text);
            onChange(text);
          }}
          multiline
          autoFocus
          textAlignVertical="top"
          className="min-h-[300px] text-base leading-6 text-label"
          style={{ fontFamily: AppFont.regular }}
        />
      </View>
    );
  }

  return (
    <View>
      {editable ? (
        <View className="mb-2 flex-row justify-end">
          <Pressable
            testID="enhanced-edit"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => setEditingState(true)}
          >
            <Text className="text-[15px] font-semibold text-link">Edit</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        testID="enhanced-read"
        disabled={!editable}
        // Screen readers move through the rendered headings and paragraphs; Edit enters editing.
        accessible={false}
        onPress={() => setEditingState(true)}
        // A long press selects text; without this handler Pressable would treat it as a tap.
        onLongPress={() => {}}
      >
        <MarkdownRenderer content={draft} selectable />
      </Pressable>
    </View>
  );
}
