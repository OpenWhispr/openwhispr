import { useMemo } from 'react';
import type { Note } from '@/data';
import { groupNotesByDate } from '@/lib/groupNotesByDate';

export function useNoteBuckets(notes: Note[]) {
  return useMemo(() => groupNotesByDate(notes), [notes]);
}
