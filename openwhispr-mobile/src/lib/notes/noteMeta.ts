import type { CalendarParticipant } from '@/data/calendarTypes';
import {
  attendeeName as defaultAttendeeName,
  formatAttendeeChipLabel as defaultAttendeeChipLabel,
  formatNoteMetaDateWithPresentation,
  type AttendeeLabels,
  type NoteDatePresentation,
} from './noteMetaCore';

export { isSameDay, markViewer, noteTakenAt, sortAttendees } from './noteMetaCore';

// Shared callers can supply presentation; the default entry keeps the original API behavior.
export const formatNoteMetaDate: (
  timestamp: string | Date | null | undefined,
  now: Date,
  presentation?: NoteDatePresentation,
) => string = (timestamp, now) => formatNoteMetaDateWithPresentation(timestamp, now);

export const attendeeName: (participant: CalendarParticipant, labels?: AttendeeLabels) => string = (
  participant,
) => defaultAttendeeName(participant);

export const formatAttendeeChipLabel: (
  participants: CalendarParticipant[],
  labels?: AttendeeLabels,
) => string | null = (participants) => defaultAttendeeChipLabel(participants);
