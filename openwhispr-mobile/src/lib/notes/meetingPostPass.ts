import * as FileSystem from 'expo-file-system/legacy';
import type { AudioWindow } from '../../services/transcription/realtimeReconnect';
import type { TranscriptionResponse } from '../../types';
import type { CloudMeetingSegment } from './cloudMeetingSegments';
import { WAV_HEADER_BYTES, extractWavRange, splitWindows } from './wavRange';

/** Two minutes of 16 kHz mono WAV (~3.84 MB) stays under the cloud's inline upload limit. */
export const BACKFILL_CHUNK_MS = 120_000;
/** Shorter scraps are mostly the edge of an outage and rarely hold a word. */
export const BACKFILL_MIN_MS = 2000;

const RECORDING_BYTES_PER_MS = 32;

export interface PostPassDeps {
  extract(uri: string, startMs: number, endMs: number): Promise<string>;
  /** Text of one stretch; empty for silence. */
  transcribe(uri: string): Promise<string>;
  cleanup(uri: string): Promise<void>;
}

const transcribeWithOneRetry = async (deps: PostPassDeps, uri: string): Promise<string | null> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await deps.transcribe(uri);
    } catch {
      // A dropped upload is often the same flaky network that caused the outage.
    }
  }
  return null;
};

/** Transcribes each dropped stretch and returns segments for the text it got. Never rejects: a failed stretch is skipped and counted. */
export async function backfillDroppedAudio(
  recordingUri: string,
  windows: AudioWindow[],
  deps: PostPassDeps,
): Promise<{ segments: CloudMeetingSegment[]; failed: number }> {
  const segments: CloudMeetingSegment[] = [];
  let failed = 0;
  // One piece at a time keeps memory and upload bandwidth bounded on a long outage.
  for (const piece of splitWindows(windows, BACKFILL_CHUNK_MS, BACKFILL_MIN_MS)) {
    let pieceUri: string;
    try {
      pieceUri = await deps.extract(recordingUri, piece.startMs, piece.endMs);
    } catch {
      // The recording may not reach this far (it stopped early): nothing to transcribe.
      continue;
    }
    try {
      const text = await transcribeWithOneRetry(deps, pieceUri);
      if (text === null) {
        failed += 1;
      } else if (text.trim()) {
        segments.push({
          text: text.trim(),
          startMs: piece.startMs,
          endMs: piece.endMs,
          speakerLabel: null,
          sortOrder: segments.length,
        });
      }
    } finally {
      const extracted = pieceUri;
      await Promise.resolve()
        .then(() => deps.cleanup(extracted))
        .catch(() => undefined);
    }
  }
  return { segments, failed };
}

/** Live and backfilled segments in time order, sortOrder renumbered. */
export function mergeTranscript(
  live: CloudMeetingSegment[],
  backfilled: CloudMeetingSegment[],
): CloudMeetingSegment[] {
  // Array.prototype.sort is stable, so live text stays ahead of a backfilled piece at the same time.
  return [...live, ...backfilled]
    .sort((a, b) => a.startMs - b.startMs)
    .map((segment, index) => ({ ...segment, sortOrder: index }));
}

/* eslint-disable @typescript-eslint/no-var-requires */
// Lazy, like the store's other transcription deps: keeps the upload stack off the store's import path.
const cloudTranscribe = async (
  audioUri: string,
  language: string | undefined,
): Promise<TranscriptionResponse | null> => {
  const { TranscriptionService } =
    require('@/services/transcription/TranscriptionService') as typeof import('@/services/transcription/TranscriptionService');
  const { isNoSpeechError } = require('@/lib/permissions') as typeof import('@/lib/permissions');
  try {
    return await TranscriptionService.transcribe({
      audioUri,
      provider: 'cloud',
      purpose: 'meeting',
      requestContext: 'recording',
      fileName: 'meeting.wav',
      mimeType: 'audio/wav',
      language,
    });
  } catch (error) {
    // The cloud answers silence with an error; for a meeting it just means no words.
    if (isNoSpeechError(error)) return null;
    throw error;
  }
};
/* eslint-enable @typescript-eslint/no-var-requires */

/** Cloud transcription of extracted stretches, with each temp file removed afterwards. */
export function createCloudPostPassDeps(language: string | undefined): PostPassDeps {
  return {
    extract: extractWavRange,
    transcribe: async (uri) => (await cloudTranscribe(uri, language))?.text ?? '',
    cleanup: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
  };
}

const recordingDurationMs = async (uri: string): Promise<number> => {
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);
  const bytes = info?.exists && 'size' in info ? info.size : 0;
  return Math.max(0, Math.floor((bytes - WAV_HEADER_BYTES) / RECORDING_BYTES_PER_MS));
};

/** Transcribes a whole meeting recording through the cloud; rejects when the cloud can't be reached. */
export async function transcribeRecordingToSegments(
  recordingUri: string,
  language: string | undefined,
): Promise<CloudMeetingSegment[]> {
  const response = await cloudTranscribe(recordingUri, language);
  if (!response) return [];
  // A long recording goes up in chunks, each timed on the recording's clock (centiseconds).
  const timed = (response.segments ?? [])
    .map((segment) => ({
      text: segment.text.trim(),
      startMs: segment.t0 * 10,
      endMs: Math.max(segment.t1, segment.t0) * 10,
    }))
    .filter((segment) => segment.text);
  if (timed.length > 0) {
    return timed.map((segment, index) => ({ ...segment, speakerLabel: null, sortOrder: index }));
  }
  const text = response.text.trim();
  if (!text) return [];
  return [
    {
      text,
      startMs: 0,
      endMs: await recordingDurationMs(recordingUri),
      speakerLabel: null,
      sortOrder: 0,
    },
  ];
}
