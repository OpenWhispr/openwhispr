import type { DiarizationSettings } from "./fileTranscription";

export interface UploadSegment {
  text: string;
  start: number;
  end?: number;
  speaker?: string;
}

// Serializes provider timing segments into the note.transcript JSON the
// meeting path already stores, unlocking the Transcript tab and the
// SRT/TXT/JSON/MD export for upload notes. Timestamps are stored on the same
// epoch-ms base the meeting path writes (anchorMs + offset), NOT in relative
// seconds: the record button on any note seeds a meeting recording from
// note.transcript and appends Date.now()-stamped live segments, and a
// mixed-base transcript defeats the export rebase (normalizeSegmentTimestamps
// keys off min timestamp > 1e9), rendering garbage cue times. The rebase
// subtracts the minimum on export, so pure-upload output is unchanged.
// Speakers are stored as the meeting path's ids (speaker_0, … in order of first
// appearance), never as names: the UI translates "Speaker N" from them, renaming
// keys its mappings on them, mobile reads them, and a recording later made into
// the note numbers its own speakers after them.
// Undefined when there is nothing usable. The transcript is the note's only
// copy of the text, so a segment with words but no start (no producer emits one
// today) drops the timing altogether and the caller stores the text untimed.
export function buildUploadTranscript(
  segments?: UploadSegment[] | null,
  anchorMs: number = Date.now()
): string | undefined {
  const spoken = segments?.filter((seg) => seg.text?.trim()) ?? [];
  if (!spoken.length || spoken.some((seg) => !Number.isFinite(seg.start))) return undefined;
  const speakerIds = new Map<string, string>();
  const stored = spoken.map((seg) => {
    if (seg.speaker && !speakerIds.has(seg.speaker)) {
      speakerIds.set(seg.speaker, `speaker_${speakerIds.size}`);
    }
    return {
      text: seg.text.trim(),
      timestamp: anchorMs + seg.start * 1000,
      ...(seg.speaker ? { speaker: speakerIds.get(seg.speaker) } : {}),
    };
  });
  return JSON.stringify(stored);
}

// What an upload persists onto the note row about the diarization run,
// matching the meeting path's write semantics: the columns are written only
// when diarization ran. A null diarization_enabled means "user never chose" and
// consumers fall back to the global speaker setting — writing 0 would force
// diarization off when recording into the note later. The speaker count the
// user entered is never stored: the upload applied it as a cap on detected
// speakers, but recording into the note forces expected_speaker_count as the
// exact count, so a generous cap would split that meeting into phantoms.
export function buildUploadNoteMetadata(
  diarization: DiarizationSettings,
  durationSeconds?: number | null,
  segments?: UploadSegment[] | null,
  anchorMs?: number
) {
  return {
    transcript: buildUploadTranscript(segments, anchorMs),
    noteUpdates: diarization.enabled ? { diarization_enabled: 1 } : null,
    audioDurationSeconds:
      typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : null,
  };
}

interface SaveUploadNoteParams {
  title: string;
  text: string;
  sourceName: string;
  folderId: number | null;
  diarization: DiarizationSettings;
  durationSeconds?: number | null;
  segments?: UploadSegment[] | null;
}

// The one save path for upload and URL-ingest notes, shared by the single-file
// flow and the batch queue. The transcription goes in the insert as the note's
// transcript, timed when the provider gave segments and untimed otherwise, so
// "Your notes" stays the user's own and the note-added event and file mirror
// see the text even if the later metadata write fails. The duration goes in the
// insert too (updateNote does not whitelist audio_duration_seconds); the
// diarization column follows through updateNote, as on the meeting path.
export async function saveUploadNote({
  title,
  text,
  sourceName,
  folderId,
  diarization,
  durationSeconds,
  segments,
}: SaveUploadNoteParams) {
  const { transcript, audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    diarization,
    durationSeconds,
    segments
  );
  const res = await window.electronAPI.saveNote(
    title,
    "",
    "upload",
    sourceName,
    audioDurationSeconds,
    folderId,
    null,
    transcript ?? JSON.stringify([{ text }])
  );
  if (res.success && res.note && noteUpdates) {
    // Best-effort: a failed metadata write must not error a saved note.
    await window.electronAPI.updateNote(res.note.id, noteUpdates).catch(() => {});
  }
  return res;
}

// First words of the transcript, else the file name without its extension.
export function uploadTitleFallback(text: string, fileName: string): string {
  const words = text.trim().split(/\s+/);
  const preview = words.slice(0, 6).join(" ") + (words.length > 6 ? "..." : "");
  return preview || fileName.replace(/\.[^.]+$/, "");
}
