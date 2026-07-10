import type { CalendarAttendee } from "../types/calendar";

// Expected total speaker count for a meeting note: the stored value, else derived from
// calendar participants (non-self attendees + you), else null so callers use their default.
export const resolveExpectedSpeakerCount = (note?: {
  expected_speaker_count?: number | null;
  participants?: string | null;
}): number | null => {
  if (note?.expected_speaker_count != null) return note.expected_speaker_count;
  if (!note?.participants) return null;

  let attendees: CalendarAttendee[];
  try {
    const parsed = JSON.parse(note.participants);
    attendees = Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }

  const others = attendees.filter((attendee) => attendee?.self !== true).length;
  return others > 0 ? others + 1 : null;
};
