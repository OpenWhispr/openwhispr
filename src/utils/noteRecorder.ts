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
  recordedByUser: boolean;
  user: PersonRef | null | undefined;
  /** The original recorder's entry in the team space roster, when it has loaded. */
  recorder: PersonRef | null | undefined;
  participants: CalendarAttendee[];
}

type RecorderNote = Pick<NoteItem, "cloud_id" | "owner_user_id" | "created_by_user_id">;

export function noteRecorderUserId(note: RecorderNote): string | null | undefined {
  // An explicit null clears attribution; only legacy metadata falls back to the owner.
  return note.created_by_user_id !== undefined ? note.created_by_user_id : note.owner_user_id;
}

export function isNoteRecorder(
  note: RecorderNote,
  currentUserId: string | null | undefined
): boolean {
  if (!note.cloud_id) return ownsNote(note, currentUserId);
  const recorderId = noteRecorderUserId(note);
  return recorderId != null && recorderId === currentUserId;
}

const toIdentity = (
  person: PersonRef | null | undefined,
  participants: CalendarAttendee[]
): MeetingIdentity => ({
  selfName: person?.name?.trim() || null,
  selfEmail: person?.email?.trim() || null,
  participants,
});

/** Legacy segments have no session recorder, so their fallback is the note creator. */
export function resolveNoteRecorder({
  recordedByUser,
  user,
  recorder,
  participants,
}: NoteRecorderSource): MeetingIdentity {
  if (recordedByUser) return toIdentity(user, participants);
  if (recorder) return toIdentity(recorder, participants);
  const flagged = participants.find((participant) => participant.self);
  return toIdentity(
    flagged ? { name: flagged.displayName, email: flagged.email } : null,
    participants
  );
}

const otherRecorderLabel = (recorder: MeetingIdentity, t: Translate): string =>
  recorder.selfName || recorder.selfEmail || t("notes.speaker.noteTaker");

/** The recorder's label in the transcript view: "You" only for the original recorder. */
export function recorderTranscriptLabel(
  recorder: MeetingIdentity,
  recordedByUser: boolean,
  t: Translate
): string {
  return recordedByUser ? t("notes.speaker.you") : otherRecorderLabel(recorder, t);
}

/** The recorder's label in the note generation payload: a real name whenever one is known. */
export function recorderLlmLabel(
  recorder: MeetingIdentity,
  recordedByUser: boolean,
  t: Translate
): string {
  return recordedByUser
    ? recorder.selfName || t("notes.speaker.you")
    : otherRecorderLabel(recorder, t);
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
  note: RecorderNote | null,
  user: (PersonRef & { id: string }) | null | undefined,
  t: Translate
): string | undefined {
  return note && !isNoteRecorder(note, user?.id)
    ? resolveSpeakerAssignmentName(t("notes.speaker.you"), user, false, t)
    : undefined;
}
