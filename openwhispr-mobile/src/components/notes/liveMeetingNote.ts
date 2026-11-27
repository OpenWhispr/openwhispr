import { createContext, useContext } from 'react';

// Kept apart from MeetingSessionProvider so list and editor screens can ask which note is live
// without importing the recorder, sync and store graph the session itself needs.
// The session value changes every second (captured time, captions). Surfaces that only need to
// know which note is recording read this one, whose value changes only when a meeting starts or ends.
export const LiveMeetingNoteContext = createContext<number | null>(null);

/** The note the live meeting is recording, or null. Re-renders only when a meeting starts or ends. */
export function useLiveMeetingNoteId(): number | null {
  return useContext(LiveMeetingNoteContext);
}
