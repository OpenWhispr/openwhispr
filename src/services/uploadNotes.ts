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
// Undefined when there is nothing usable, so plain-text uploads stay exactly
// as they were.
export function buildUploadTranscript(
  segments?: UploadSegment[] | null,
  anchorMs: number = Date.now()
): string | undefined {
  if (!segments?.length) return undefined;
  const stored = segments
    .filter((seg) => seg.text?.trim() && Number.isFinite(seg.start))
    .map((seg) => ({
      text: seg.text.trim(),
      timestamp: anchorMs + seg.start * 1000,
      ...(seg.speaker ? { speakerName: seg.speaker } : {}),
    }));
  return stored.length ? JSON.stringify(stored) : undefined;
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
  const transcript = buildUploadTranscript(segments, anchorMs);
  const noteUpdates: Record<string, unknown> | null =
    diarization.enabled || transcript
      ? {
          ...(diarization.enabled ? { diarization_enabled: 1 } : {}),
          ...(transcript ? { transcript } : {}),
        }
      : null;
  return {
    audioDurationSeconds:
      typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : null,
    noteUpdates,
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
// flow and the batch queue: the duration goes in the insert (updateNote does
// not whitelist audio_duration_seconds), and the diarization columns and the
// timestamped transcript follow through updateNote — the same route the
// meeting path writes them through.
export async function saveUploadNote({
  title,
  text,
  sourceName,
  folderId,
  diarization,
  durationSeconds,
  segments,
}: SaveUploadNoteParams) {
  const { audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    diarization,
    durationSeconds,
    segments
  );
  const res = await window.electronAPI.saveNote(
    title,
    text,
    "upload",
    sourceName,
    audioDurationSeconds,
    folderId
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
