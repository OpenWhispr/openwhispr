import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { formatNoteRowTime } from '@/lib/formatNoteRowTime.android';
import { createNoteRow } from './NoteRowCore';

export const NoteRow = createNoteRow(function useNotePresentation({ onDelete, onMove }) {
  const { copy, language } = useAndroidCopy();
  return {
    copy,
    formatTime: (updatedAt, bucket) =>
      formatNoteRowTime(updatedAt, bucket, language, copy('library.yesterday', 'Yesterday')),
    rowAccessibility: () => ({
      accessibilityActions: [
        ...(onMove ? [{ name: 'move', label: copy('moveAction', 'Move') }] : []),
        { name: 'delete', label: copy('deleteAction', 'Delete') },
      ],
      onAccessibilityAction: ({ nativeEvent }) => {
        if (nativeEvent.actionName === 'move') onMove?.();
        else if (nativeEvent.actionName === 'delete') onDelete();
      },
    }),
  };
});
