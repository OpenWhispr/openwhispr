import type { CalendarParticipant } from '@/data/calendarTypes';
import { getCalendarSpeakerLabelSuggestions } from '@/lib/calendar/meetingContext';
import { DEFAULT_MEETING_TITLE } from '@/lib/notes/meetingConstants';

export interface MeetingNotesContext {
  eventTitle?: string | null;
  participants?: CalendarParticipant[] | null;
}

export interface BuildMeetingNotesInputArgs {
  rawNotes?: string | null;
  transcript?: string | null;
  meetingContext?: MeetingNotesContext | null;
}

const formatParticipantHint = (hint: { label: string; email: string | null }): string | null => {
  const label = hint.label.trim();
  const email = hint.email?.trim().toLowerCase() ?? null;
  if (!label && !email) return null;
  if (label && email && label.toLowerCase() !== email) return `${label} <${email}>`;
  return label || email;
};

const buildMeetingContextBlock = (context: MeetingNotesContext | null | undefined): string => {
  if (!context) return '';

  const trimmedEventTitle = context.eventTitle?.trim();
  const eventTitle = trimmedEventTitle === DEFAULT_MEETING_TITLE ? '' : trimmedEventTitle;
  const participantHints = getCalendarSpeakerLabelSuggestions(context.participants ?? [])
    .map(formatParticipantHint)
    .filter((hint): hint is string => hint !== null);
  if (!eventTitle && participantHints.length === 0) return '';

  return [
    'Calendar context (for interpretation only; do not list this context automatically):',
    eventTitle ? `Event title: ${eventTitle}` : '',
    participantHints.length > 0 ? `Possible participant hints: ${participantHints.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

export function buildMeetingNotesInput({
  rawNotes,
  transcript,
  meetingContext,
}: BuildMeetingNotesInputArgs): string {
  const trimmedRawNotes = rawNotes?.trim();
  const trimmedTranscript = transcript?.trim();
  const contextBlock = buildMeetingContextBlock(meetingContext);

  return [
    contextBlock,
    trimmedRawNotes ? `Raw notes captured during the meeting:\n${trimmedRawNotes}` : '',
    trimmedTranscript ? `Meeting transcript:\n${trimmedTranscript}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
