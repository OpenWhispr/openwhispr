import * as FileSystem from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import type { AudioWindow } from '../../services/transcription/realtimeReconnect';
import type { TranscriptionResponse } from '../../types';
import { inSpokenOrder, type CloudMeetingSegment } from './cloudMeetingSegments';
import { EmptyWavRangeError, extractWavRange, splitWindows, wavDurationMs } from './wavRange';

/** Two minutes of 16 kHz mono WAV (~3.84 MB) stays under the cloud's inline upload limit. */
export const BACKFILL_CHUNK_MS = 120_000;
/** Shorter scraps are mostly the edge of an outage and rarely hold a word. */
export const BACKFILL_MIN_MS = 2000;
/** A pause in a saved transcript shorter than this is people not talking, not missing audio. */
export const OWED_GAP_MIN_MS = 15_000;

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

export interface BackfillResult {
  segments: CloudMeetingSegment[];
  /** Pieces not transcribed: the one that failed both tries and every piece after it. */
  failed: number;
  /** Those pieces' windows on the recording's clock, for a later attempt. */
  failedWindows: AudioWindow[];
  /** Set when `shouldStop` ended the run: the pieces left were never tried, not refused. */
  stopped?: true;
}

/**
 * Transcribes each dropped stretch and returns segments for the text it got. Never rejects.
 * Stops at the first piece that fails twice: offline, every later piece would wait out the
 * same upload timeouts while the user watches the processing screen. A piece that can't be cut
 * from the recording (a full disk, an unreadable file) stops it the same way: only a stretch
 * the recording doesn't hold is skipped.
 */
export async function backfillDroppedAudio(
  recordingUri: string,
  windows: AudioWindow[],
  deps: PostPassDeps,
  /** Asked before each piece; true leaves that piece and the rest owed. */
  options: { shouldStop?: () => boolean } = {},
): Promise<BackfillResult> {
  const segments: CloudMeetingSegment[] = [];
  const pieces = splitWindows(windows, BACKFILL_CHUNK_MS, BACKFILL_MIN_MS);
  // One piece at a time keeps memory and upload bandwidth bounded on a long outage.
  for (const [index, piece] of pieces.entries()) {
    if (options.shouldStop?.()) {
      const failedWindows = pieces.slice(index);
      return { segments, failed: failedWindows.length, failedWindows, stopped: true };
    }
    let pieceUri: string;
    try {
      pieceUri = await deps.extract(recordingUri, piece.startMs, piece.endMs);
    } catch (error) {
      // The recording may not reach this far (it stopped early): nothing to transcribe.
      if (error instanceof EmptyWavRangeError) continue;
      // Anything else says nothing about the audio, which is still owed.
      const failedWindows = pieces.slice(index);
      return { segments, failed: failedWindows.length, failedWindows };
    }
    let text: string | null;
    try {
      text = await transcribeWithOneRetry(deps, pieceUri);
    } finally {
      const extracted = pieceUri;
      await Promise.resolve()
        .then(() => deps.cleanup(extracted))
        .catch(() => undefined);
    }
    if (text === null) {
      const failedWindows = pieces.slice(index);
      return { segments, failed: failedWindows.length, failedWindows };
    }
    if (text.trim()) {
      segments.push({
        text: text.trim(),
        startMs: piece.startMs,
        endMs: piece.endMs,
        speakerLabel: null,
        sortOrder: segments.length,
      });
    }
  }
  return { segments, failed: 0, failedWindows: [] };
}

/**
 * Live and backfilled segments in spoken order. A backfilled piece whose exact window a row
 * already holds was merged by an earlier run that died before it could record so, and is left
 * out. That row may carry a speaker by now, but the speaker pass never moves a row's times.
 */
export function mergeTranscript(
  live: CloudMeetingSegment[],
  backfilled: CloudMeetingSegment[],
): CloudMeetingSegment[] {
  const merged = new Set(live.map((row) => `${row.startMs}:${row.endMs}`));
  const fresh = backfilled.filter((piece) => !merged.has(`${piece.startMs}:${piece.endMs}`));
  // Live first, so live text stays ahead of a backfilled piece that starts at the same time.
  return inSpokenOrder([...live, ...fresh]);
}

/**
 * The stretches of a recording a saved transcript doesn't cover: before its first segment, long
 * pauses between segments, and after its last. For a meeting whose list of dropped audio was lost
 * (the app was killed), this is the best account of what the recording still holds.
 */
export function owedWindowsFromSegments(
  segments: { startMs: number; endMs: number }[],
  durationMs: number,
): AudioWindow[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const owed: AudioWindow[] = [];
  const owe = (startMs: number, endMs: number, minMs: number): void => {
    if (endMs - startMs >= Math.max(minMs, BACKFILL_MIN_MS)) owed.push({ startMs, endMs });
  };
  const sorted = segments
    .filter(
      (segment) =>
        Number.isFinite(segment.startMs) &&
        Number.isFinite(segment.endMs) &&
        segment.startMs >= 0 &&
        segment.endMs >= segment.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs);
  if (sorted.length === 0) {
    owe(0, durationMs, 0);
    return owed;
  }
  owe(0, Math.min(sorted[0].startMs, durationMs), 0);
  // The furthest end so far: an overlapping segment never opens a gap inside another.
  let coveredTo = sorted[0].endMs;
  for (const segment of sorted.slice(1)) {
    owe(coveredTo, Math.min(segment.startMs, durationMs), OWED_GAP_MIN_MS);
    coveredTo = Math.max(coveredTo, segment.endMs);
  }
  owe(coveredTo, durationMs, 0);
  return owed;
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

/**
 * A meeting recording's length from its size: 0 when there is no file, and null when its size
 * can't be read, which a caller must not take for a recording that holds nothing.
 */
export const recordingDurationMs = async (uri: string): Promise<number | null> => {
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);
  if (!info) return null;
  if (!info.exists) return 0;
  if (!('size' in info) || typeof info.size !== 'number') return null;
  return wavDurationMs(info.size);
};

/** A failure's own code for a Sentry tag, or 'unknown'; never its message, which can carry file paths. */
export const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
};

/** Unsure counts as online: a wrong guess costs one failed upload, never an attempt not made. */
export const isDeviceOnline = (): Promise<boolean> =>
  Network.getNetworkStateAsync().then(
    (state) => state.isConnected !== false,
    () => true,
  );

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
      endMs: (await recordingDurationMs(recordingUri)) ?? 0,
      speakerLabel: null,
      sortOrder: 0,
    },
  ];
}
