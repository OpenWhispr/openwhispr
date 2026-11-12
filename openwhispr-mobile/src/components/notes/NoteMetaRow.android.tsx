import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createNoteMetaRow } from './NoteMetaRowCore.android';

export const NoteMetaRow = createNoteMetaRow(function useMetadataPresentation() {
  const { copy } = useAndroidCopy();
  return {
    copy,
    chipClassName:
      'min-h-12 max-w-full flex-row items-center gap-1.5 rounded-full bg-tertiarySystemFill px-3 py-2',
  };
});
