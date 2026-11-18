import { formatNoteMetaDateWithPresentation, type NoteDatePresentation } from './noteMetaCore';

export {
  attendeeName,
  formatAttendeeChipLabel,
  isSameDay,
  markViewer,
  noteTakenAt,
  sortAttendees,
} from './noteMetaCore';

export function formatNoteMetaDate(
  timestamp: string | Date | null | undefined,
  now: Date,
  presentation?: NoteDatePresentation,
): string {
  return formatNoteMetaDateWithPresentation(timestamp, now, presentation, true);
}
