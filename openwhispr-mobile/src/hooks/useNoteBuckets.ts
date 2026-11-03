import { useMemo } from 'react';
import { Platform } from 'react-native';
import type { Note } from '@/data';
import { groupNotesByDate } from '@/lib/groupNotesByDate';
import { useAndroidCopy } from './useAndroidCopy';

/** Keep date grouping identical while presenting Android headings in the app locale. */
export function useNoteBuckets(notes: Note[]) {
  const { copy, language } = useAndroidCopy();
  return useMemo(
    () =>
      groupNotesByDate(
        notes,
        new Date(),
        Platform.OS === 'android'
          ? {
              language,
              labels: {
                today: copy('library.today', 'Today'),
                yesterday: copy('library.yesterday', 'Yesterday'),
                prev7: copy('library.previous7', 'Previous 7 Days'),
                prev30: copy('library.previous30', 'Previous 30 Days'),
              },
            }
          : undefined,
      ),
    [notes, copy, language],
  );
}
