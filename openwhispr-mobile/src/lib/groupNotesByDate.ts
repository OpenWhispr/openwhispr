import type { Note } from '@/data';
import { groupNotesByDateWithPresentation } from './groupNotesByDateCore';

export type { DateBucket, DateBucketKey } from './groupNotesByDateCore';

export function groupNotesByDate(notes: Note[], now: Date = new Date()) {
  return groupNotesByDateWithPresentation(notes, now);
}
