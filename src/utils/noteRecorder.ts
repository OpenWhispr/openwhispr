import type { CalendarAttendee } from "../types/calendar";
import type { MeetingIdentity } from "./llmTranscript";

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface PersonRef {
  name?: string | null;
  email?: string | null;
}

interface NoteRecorderSource {
  ownNote: boolean;
  user: PersonRef | null | undefined;
  /** The note owner's entry in the team space roster, when it has loaded. */
  owner: PersonRef | null | undefined;
  participants: CalendarAttendee[];
}

const toIdentity = (
  person: PersonRef | null | undefined,
  participants: CalendarAttendee[]
): MeetingIdentity => ({
  selfName: person?.name?.trim() || null,
  selfEmail: person?.email?.trim() || null,
  participants,
});

/**
 * Whoever recorded the note, whose voice the mic lines ("you") carry: the user
 * on their own note. On a teammate's note it's the owner from the space roster,
 * else the attendee the recorder's calendar flagged `self`; never the viewer,
 * who is at most an attendee there. Unknown leaves name and email null.
 */
export function resolveNoteRecorder({
  ownNote,
  user,
  owner,
  participants,
}: NoteRecorderSource): MeetingIdentity {
  if (ownNote) return toIdentity(user, participants);
  if (owner) return toIdentity(owner, participants);
  const flagged = participants.find((participant) => participant.self);
  return toIdentity(
    flagged ? { name: flagged.displayName, email: flagged.email } : null,
    participants
  );
}

const otherRecorderLabel = (recorder: MeetingIdentity, t: Translate): string =>
  recorder.selfName || recorder.selfEmail || t("notes.speaker.noteTaker");

/** The recorder's label in the transcript view: "You" only on the user's own note. */
export function recorderTranscriptLabel(
  recorder: MeetingIdentity,
  ownNote: boolean,
  t: Translate
): string {
  return ownNote ? t("notes.speaker.you") : otherRecorderLabel(recorder, t);
}

/** The recorder's label in the note generation payload: a real name whenever one is known. */
export function recorderLlmLabel(
  recorder: MeetingIdentity,
  ownNote: boolean,
  t: Translate
): string {
  return ownNote ? recorder.selfName || t("notes.speaker.you") : otherRecorderLabel(recorder, t);
}
