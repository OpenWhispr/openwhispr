import type { Diarizer } from '@/lib/diarization/diarizer';
import { assertTransition } from '@/lib/diarization/transcriptionStatus';
import {
  whisperSegmentsToWords,
  diarizationToTurns,
  speakerLabelFor,
} from '@/lib/diarization/diarizationBridge';
import { mergeWordsWithSpeakers } from '@/lib/diarization/mergeSegments';
import { applyProvisional } from '@/lib/diarization/speakerState';
import type { TranscriptionResponse, TranscriptionStatus } from '@/types';
import type { NewSegment, NewSpeaker, Speaker } from '@/data/types';

/**
 * Tuned blip-absorption threshold passed to mergeWordsWithSpeakers for meeting transcriptions.
 * Absorbs speaker blips shorter than this duration into the preceding segment.
 * Caller can override via ProcessMeetingInput.minSegmentMs.
 */
export const DEFAULT_MIN_SEGMENT_MS = 1500;

export interface DiarizationDeps {
  transcribe: (
    audioUri: string,
    opts: { wordTimestamps: boolean; modelName?: string; language?: string },
  ) => Promise<TranscriptionResponse>;
  diarizer: Diarizer;
  repo: {
    getTranscriptionStatus(noteId: number): TranscriptionStatus;
    getSpeakers(noteId: number): Speaker[];
    replaceSegments(noteId: number, segments: NewSegment[]): void;
    upsertSpeakers(noteId: number, rows: NewSpeaker[]): void;
    updateSpeaker(id: number, updates: Partial<Speaker>): void;
    setTranscriptionStatus(noteId: number, status: TranscriptionStatus): void;
  };
}

export interface ProcessMeetingInput {
  noteId: number;
  wavUri: string;
  expectedSpeakerCount?: number;
  modelName?: string;
  language?: string;
  minSegmentMs?: number;
}

export interface ProcessMeetingResult {
  speakerEmbeddingsByLabel: Record<string, number[]>;
}

export const processMeeting = async (
  input: ProcessMeetingInput,
  deps: DiarizationDeps,
): Promise<ProcessMeetingResult> => {
  const { noteId, wavUri } = input;
  const countHint = input.expectedSpeakerCount ?? 0;
  const minSegmentMs = input.minSegmentMs ?? DEFAULT_MIN_SEGMENT_MS;

  // Seed from the note's REAL current status (handles re-diarize from a terminal state), and assert
  // every transition so an illegal jump throws.
  let current: TranscriptionStatus = deps.repo.getTranscriptionStatus(noteId);
  const advance = (next: TranscriptionStatus): void => {
    assertTransition(current, next);
    deps.repo.setTranscriptionStatus(noteId, next);
    current = next;
  };

  try {
    advance('transcribing');
    const transcription = await deps.transcribe(wavUri, {
      wordTimestamps: true,
      modelName: input.modelName,
      language: input.language,
    });
    const words = whisperSegmentsToWords(transcription.segments ?? []);
    if (words.length === 0) {
      // Guard: no word timestamps means we cannot build a speaker-labelled transcript.
      // Fail loudly instead of persisting an empty "done" meeting.
      throw new Error(
        'No word timestamps from transcription; cannot build a speaker-labelled transcript.',
      );
    }

    advance('diarizing');
    const diarization = await deps.diarizer.diarize(wavUri, countHint);
    const turns = diarizationToTurns(diarization);
    const speakerEmbeddingsByLabel = Object.fromEntries(
      Object.entries(diarization.embeddings).map(([id, embedding]) => [
        speakerLabelFor(Number(id)),
        embedding,
      ]),
    );

    const merged = mergeWordsWithSpeakers(words, turns, { minSegmentMs });

    const segments: NewSegment[] = merged.map((seg) => ({
      noteId,
      text: seg.text,
      startMs: seg.startMs,
      endMs: seg.endMs,
      speakerLabel: seg.speakerLabel,
    }));
    deps.repo.replaceSegments(noteId, segments);

    // Insert only speakers that don't already exist; never touch existing rows (preserves locks).
    const existingLabels = new Set(deps.repo.getSpeakers(noteId).map((s) => s.speakerLabel));
    const newLabels = [...new Set(merged.map((s) => s.speakerLabel))].filter(
      (l) => !existingLabels.has(l),
    );
    const newSpeakers: NewSpeaker[] = newLabels.map((label) => {
      // Route through applyProvisional so new speakers always carry the canonical provisional state.
      const state = applyProvisional({}, { displayName: null });
      return {
        noteId,
        speakerLabel: label,
        displayName: state.displayName ?? null,
        speakerStatus: state.speakerStatus ?? 'provisional',
        // speakerLocked is an integer (0/1) in SQLite; boolean→int boundary map lives here.
        speakerLocked: state.speakerLocked ? 1 : 0,
      };
    });
    if (newSpeakers.length > 0) deps.repo.upsertSpeakers(noteId, newSpeakers);

    advance('done');
    return { speakerEmbeddingsByLabel };
  } catch (error) {
    // Record failure directly (not via advance): failure must always be recordable regardless of
    // intermediate state, and must not mask the original error by re-running assertTransition.
    deps.repo.setTranscriptionStatus(noteId, 'failed');
    throw error;
  }
};
