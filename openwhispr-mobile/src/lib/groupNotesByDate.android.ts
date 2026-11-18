import type { Note } from '@/data';
import { groupNotesByDateWithPresentation } from './groupNotesByDateCore';

export type { DateBucket, DateBucketKey } from './groupNotesByDateCore';

export function groupNotesByDate(
  notes: Note[],
  now: Date = new Date(),
  presentation?: { language: string; labels: Record<string, string> },
) {
  return groupNotesByDateWithPresentation(
    notes,
    now,
    presentation
      ? {
          labels: presentation.labels,
          monthLabel: (date) =>
            date.toLocaleDateString(presentation.language, { month: 'long', year: 'numeric' }),
        }
      : undefined,
  );
}
