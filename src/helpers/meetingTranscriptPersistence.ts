import type { TranscriptSegment } from "../stores/meetingRecordingStore";

// Session-scoped persistence for meeting transcripts. This lives outside the
// notes view because a recording can stop without the user driving it
// (auto-end, owner loss) while another view — or another note — is open; any
// persistence keyed to a mounted editor would silently drop the result.

export interface PendingMeetingDiarizationPersistence {
  sessionId: string;
  noteId: number;
}

export interface MeetingTranscriptPersistenceIO {
  getNote: (noteId: number) => Promise<{ transcript?: string | null } | null | undefined>;
  updateNote: (noteId: number, updates: { transcript: string }) => Promise<unknown> | unknown;
  saveNoteSpeakerEmbeddings: (
    noteId: number,
    embeddings: Record<string, number[]>
  ) => Promise<unknown> | unknown;
  parseSegments: (raw: string) => TranscriptSegment[];
  mergeSegments: (
    existing: TranscriptSegment[],
    incoming: TranscriptSegment[]
  ) => TranscriptSegment[];
  serializeSegments: (segments: TranscriptSegment[]) => string;
}

export function buildFinalMeetingTranscript(
  segments: TranscriptSegment[],
  fallbackTranscript: string,
  serializeSegments: (segments: TranscriptSegment[]) => string
): string | null {
  if (segments.length > 0) return serializeSegments(segments);
  return fallbackTranscript || null;
}

export async function persistDiarizedMeetingTranscript({
  noteId,
  diarizedSegments,
  speakerEmbeddings,
  liveSegments,
  io,
}: {
  noteId: number;
  diarizedSegments: TranscriptSegment[];
  speakerEmbeddings: Record<string, number[]> | null | undefined;
  liveSegments: TranscriptSegment[];
  io: MeetingTranscriptPersistenceIO;
}): Promise<void> {
  // Merge into the persisted transcript so speaker locks or edits made after
  // the stop survive; fall back to the live segments if the note can't be read.
  let existing = liveSegments;
  try {
    const persisted = await io.getNote(noteId);
    if (persisted?.transcript) existing = io.parseSegments(persisted.transcript);
  } catch {
    // keep the live-segment fallback
  }

  const withIds = diarizedSegments.map((segment, index) => ({
    ...segment,
    id: segment.id || `diarized-${index}`,
  }));
  const enriched = io.mergeSegments(existing, withIds);
  await io.updateNote(noteId, { transcript: io.serializeSegments(enriched) });

  if (speakerEmbeddings) {
    await io.saveNoteSpeakerEmbeddings(noteId, speakerEmbeddings);
  }
}
