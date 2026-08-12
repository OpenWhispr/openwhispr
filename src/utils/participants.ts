import type { CalendarAttendee } from "../types/calendar";

interface ParticipantSpeakerCountSyncInput {
  recordingNoteId: number | null;
  noteId: number;
  userTouchedStepper: boolean;
  currentExpectedCount: number;
  participants: readonly CalendarAttendee[];
}

export const resolveParticipantExpectedSpeakerCount = (
  participants: readonly CalendarAttendee[]
): number | null => {
  const others = participants.filter((attendee) => attendee?.self !== true).length;
  return others > 0 ? others + 1 : null;
};

// Raise-only, mirroring _refreshMeetingSpeakerConfigFromNote in main: a roster
// that shrinks mid-recording must not pull the cap below the speakers already
// discovered, and main would not broadcast the lower value back anyway.
export const resolveParticipantSpeakerCountSync = ({
  recordingNoteId,
  noteId,
  userTouchedStepper,
  currentExpectedCount,
  participants,
}: ParticipantSpeakerCountSyncInput): number | null => {
  if (recordingNoteId !== noteId || userTouchedStepper) return null;

  const expectedCount = resolveParticipantExpectedSpeakerCount(participants);
  return expectedCount != null && expectedCount > currentExpectedCount ? expectedCount : null;
};

export const resolveInitialSpeakerCountOverride = (
  expectedCount: number | null | undefined,
  expectedCountIsExplicit?: boolean
): boolean => expectedCountIsExplicit ?? expectedCount != null;

// A stored count only counts as the user's own choice when it is usable; the
// cloud pull persists the server value unvalidated, so 0 and friends get here.
export const isExplicitSpeakerCount = (value?: number | null): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

// Expected total speaker count for a meeting note: the stored value, else derived from
// calendar participants (non-self attendees + you), else null so callers use their default.
export const resolveExpectedSpeakerCount = (note?: {
  expected_speaker_count?: number | null;
  participants?: string | null;
}): number | null => {
  if (isExplicitSpeakerCount(note?.expected_speaker_count)) {
    return note.expected_speaker_count;
  }
  if (!note?.participants) return null;

  let attendees: CalendarAttendee[];
  try {
    const parsed = JSON.parse(note.participants);
    attendees = Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }

  return resolveParticipantExpectedSpeakerCount(attendees);
};
