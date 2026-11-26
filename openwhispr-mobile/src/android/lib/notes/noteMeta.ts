import {
  formatNoteMetaDateWithPresentation,
  type NoteDatePresentation,
} from '@/android/lib/notes/noteMetaCore';

export {
  attendeeName,
  formatAttendeeChipLabel,
  isSameDay,
  markViewer,
  noteTakenAt,
  sortAttendees,
} from '@/android/lib/notes/noteMetaCore';

export function formatNoteMetaDate(
  timestamp: string | Date | null | undefined,
  now: Date,
  presentation?: NoteDatePresentation,
): string {
  return formatNoteMetaDateWithPresentation(timestamp, now, presentation, true);
}
