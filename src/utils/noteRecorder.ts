import { isYouSpeakerName } from "./transcriptSpeakerState";
import { ownsNote } from "../lib/spacePermissions";
import type { NoteItem } from "../types/electron";
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

/** Legacy segments have no session recorder, so their fallback is the note owner. */
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

// A relative self label cannot cross devices: a teammate's correction must
// store the person who made it, rather than becoming the owner's voice.
export function resolveSpeakerAssignmentName(
  name: string,
  user: PersonRef | null | undefined,
  ownNote: boolean,
  t: Translate
): string {
  return !ownNote && isYouSpeakerName(name, t("notes.speaker.you"))
    ? user?.name?.trim() || user?.email?.trim() || t("notes.speaker.noteTaker")
    : name;
}

export function recordingRecorderName(
  note: Pick<NoteItem, "cloud_id" | "owner_user_id"> | null,
  user: (PersonRef & { id: string }) | null | undefined,
  t: Translate
): string | undefined {
  return note && !ownsNote(note, user?.id)
    ? resolveSpeakerAssignmentName(t("notes.speaker.you"), user, false, t)
    : undefined;
}
