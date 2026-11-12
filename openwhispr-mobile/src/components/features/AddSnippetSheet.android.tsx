import { useRef } from 'react';
import { TextInput } from 'react-native';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { confirmDestructive } from '@/lib/alerts';
import { createAddSnippetSheet } from './AddSnippetSheetCore.android';

export const AddSnippetSheet = createAddSnippetSheet(function useSnippetPresentation() {
  const { copy } = useAndroidCopy();
  const replacementRef = useRef<TextInput>(null);
  return {
    copy,
    triggerProps: () => ({
      accessibilityLabel: copy('library.trigger', 'Trigger'),
      submitBehavior: 'submit',
      onSubmitEditing: () => replacementRef.current?.focus(),
    }),
    replacementProps: () => ({
      ref: replacementRef,
      accessibilityLabel: copy('library.replacement', 'Replacement'),
    }),
    confirmDelete: (title, message, onConfirm) =>
      confirmDestructive(title, message, onConfirm, {
        cancelLabel: copy('cancel', 'Cancel'),
        destructiveLabel: copy('deleteAction', 'Delete'),
      }),
  };
});
