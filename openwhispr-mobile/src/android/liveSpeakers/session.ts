import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { notesRepository } from '@/data';
import type { NewSpeaker } from '@/data/types';
import { applyProvisional } from '@/lib/diarization/speakerState';
import { mapUtterancesToSegments } from '@/lib/notes/cloudMeetingSegments';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import { useNotesStore } from '@/store/useNotesStore';
import { modelPath, modelReady } from '@/android/models';
import { applySpeakerPass, type PassLine } from './speakerPass';
import { log, meetingWavUri, MODEL, type LiveSpeakerResult } from './live';

export { finishSpeakers, startSpeakers, type LiveSpeakerResult } from './live';

const bumpTranscript = () =>
  useNotesStore.setState((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));

/** Speakers rows for labels the note doesn't have yet, numbered in the order they first speak. */
function addSpeakers(noteId: number, labels: (string | null)[]) {
  const existing = new Set(notesRepository.getSpeakers(noteId).map((s) => s.speakerLabel));
  const fresh = [...new Set(labels.filter((label): label is string => !!label))].filter(
    (label) => !existing.has(label),
  );
  if (!fresh.length) return;
  const state = applyProvisional({}, { displayName: null });
  notesRepository.upsertSpeakers(
    noteId,
    fresh.map(
      (label): NewSpeaker => ({
        noteId,
        speakerLabel: label,
        displayName: null,
        speakerStatus: state.speakerStatus ?? 'provisional',
        speakerLocked: 0,
      }),
    ),
  );
}

/** Saves the live labels onto the meeting's segments, as `finalizeCloudMeeting` wrote them. */
export function saveLiveSpeakers(
  noteId: number,
  utterances: RealtimeUtterance[],
  elapsedSeconds: number,
  result: LiveSpeakerResult,
): boolean {
  if (!Object.keys(result.labels).length) return false;
  const segments = mapUtterancesToSegments(utterances, elapsedSeconds).map((segment, index) => ({
    ...segment,
    noteId,
    speakerLabel: result.labels[utterances[index].itemId] ?? null,
  }));
  addSpeakers(
    noteId,
    segments.map((segment) => segment.speakerLabel),
  );
  notesRepository.replaceSegments(noteId, segments);
  bumpTranscript();
  return true;
}

export interface SpeakerPassDeps {
  diarize(
    uri: string,
    speakers: number,
  ): Promise<{
    segments: { start: number; end: number; speakerId: number | null }[];
  }>;
  modelReady(): Promise<boolean>;
  deleteWav(uri: string): Promise<void>;
  /** False once the account, note or transcript changed under the pass. */
  isCurrent(): boolean;
  log(message: string): void;
}

const defaultPassDeps = (): Omit<SpeakerPassDeps, 'isCurrent'> => ({
  // Straight to the native worker, not the shared inference queue: a pass can take minutes and
  // must never hold up a dictation. The native side refuses a meeting too long for memory.
  diarize: (uri, speakers) => AndroidDictation!.diarize(uri, modelPath(MODEL), speakers),
  modelReady: () => modelReady(MODEL),
  deleteWav: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
  log,
});

/**
 * After Stop: separates speakers over the whole WAV and corrects the saved lines. Skipped when
 * the provider labelled speakers. Any failure keeps the transcript as it was saved. The WAV is
 * deleted once a finished meeting no longer needs it.
 */
export async function runSpeakerPass(
  input: {
    noteId: number;
    utterances: RealtimeUtterance[];
    elapsedSeconds: number;
    result: LiveSpeakerResult;
    expectedSpeakers?: number;
  },
  deps: Partial<SpeakerPassDeps> & Pick<SpeakerPassDeps, 'isCurrent'>,
): Promise<'skipped' | 'applied' | 'unchanged' | 'failed'> {
  const {
    diarize,
    modelReady: ready,
    deleteWav,
    isCurrent,
    log: write,
  } = {
    ...defaultPassDeps(),
    ...deps,
  };
  const { noteId, utterances, result } = input;
  const wav = meetingWavUri(noteId);
  const done = () => notesRepository.getTranscriptionStatus(noteId) === 'done';
  if (!wav || !utterances.length || !done()) return 'skipped';
  if (result.providerLabelled) {
    await deleteWav(wav).catch(() => undefined);
    return 'skipped';
  }
  if (!(await ready().catch(() => false))) return 'skipped';
  const saved = notesRepository.getSegments(noteId).map((segment) => segment.text);
  const started = Date.now();
  try {
    const separation = await diarize(wav, input.expectedSpeakers ?? 0);
    write(
      `[live-speakers] pass took=${Date.now() - started}ms turns=${separation.segments.length}`,
    );
    const fallback = mapUtterancesToSegments(utterances, input.elapsedSeconds);
    const lines: PassLine[] = utterances.map((utterance, index) => {
      const span = result.spans[utterance.itemId];
      return {
        text: utterance.text.trim(),
        startMs: span?.startMs ?? fallback[index].startMs,
        endMs: span?.endMs ?? fallback[index].endMs,
        label: result.labels[utterance.itemId] ?? null,
      };
    });
    const segments = applySpeakerPass(
      lines,
      separation.segments.map((turn) => ({
        startMs: Math.round(turn.start * 1000),
        endMs: Math.round(turn.end * 1000),
        speakerId: turn.speakerId,
      })),
    );
    const current = notesRepository.getSegments(noteId).map((segment) => segment.text);
    // Someone edited the transcript, or another account is signed in: leave it alone.
    if (!isCurrent() || !done() || JSON.stringify(current) !== JSON.stringify(saved))
      return 'unchanged';
    addSpeakers(
      noteId,
      segments.map((segment) => segment.speakerLabel),
    );
    notesRepository.replaceSegments(
      noteId,
      segments.map((segment, index) => ({ ...segment, noteId, sortOrder: index })),
    );
    bumpTranscript();
    await deleteWav(wav).catch(() => undefined);
    return 'applied';
  } catch (error) {
    write(`[live-speakers] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}
