import * as FileSystem from 'expo-file-system/legacy';
import type { AudioWindow } from '@/services/transcription/realtimeReconnect';

// Retained under the cache dir, not documents: it's transient best-effort retry
// material, so it must never ride along in the user's iCloud/device backup (the
// cache dir is excluded from backup on both iOS and Android). The OS may purge it
// under storage pressure — that just looks like an early expiry, and retry already
// handles a missing file gracefully.
const TRANSCRIPT_AUDIO_DIR = `${FileSystem.cacheDirectory ?? ''}transcript-audio/`;

const MIME_EXTENSION: Record<string, string> = {
  'audio/aac': 'aac',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/x-wav': 'wav',
};

const sanitizePathPart = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);

export function isManagedTranscriptAudioUri(uri?: string | null): boolean {
  return !!uri && !!FileSystem.cacheDirectory && uri.startsWith(TRANSCRIPT_AUDIO_DIR);
}

/** The one path a meeting's recording lives at while the meeting records. */
export function meetingRecordingUri(noteId: number): string {
  return `${FileSystem.documentDirectory ?? ''}meeting-${noteId}.wav`;
}

/** source_file is synced metadata, not authority to read or delete a local path. */
export function isManagedMeetingAudioUri(noteId: number, uri?: string | null): boolean {
  return !!FileSystem.documentDirectory && uri === meetingRecordingUri(noteId);
}

/** Audio a meeting's recording still holds that no transcription reached yet; lives beside it. */
export function meetingBackfillUri(noteId: number): string {
  return `${FileSystem.documentDirectory ?? ''}meeting-${noteId}.backfill.json`;
}

const PENDING_BACKFILL_VERSION = 1;

type LivePcmStreamingModule = typeof import('../../modules/live-pcm-streaming/src');

/**
 * A meeting's files sit in Documents so iOS never purges them mid-meeting, but like the retained
 * audio above they are temporary and must never ride along in a backup. Best effort, never
 * throws. The native module is loaded lazily: this file is imported where it isn't available.
 */
export async function excludeMeetingFileFromBackup(uri: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LivePCMStreaming } =
      require('../../modules/live-pcm-streaming/src') as LivePcmStreamingModule;
    await LivePCMStreaming.excludeFromBackup(uri);
  } catch {
    // Nothing else to try; the file is still deleted once it has served.
  }
}

/** How often a resume of a note's owed audio got nothing through, and when it last tried. */
export interface BackfillRetry {
  attempts: number;
  /** Epoch ms. */
  lastAttemptAt: number;
}

export interface PendingBackfillState extends BackfillRetry {
  windows: AudioWindow[];
}

/** The wait after the first resume that got nothing through; it doubles per failed attempt. */
export const BACKFILL_RETRY_BASE_MS = 5 * 60 * 1000;
export const BACKFILL_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/** How long to wait after `attempts` resumes in a row got nothing through; 0 when none has. */
export function backfillRetryDelayMs(attempts: number): number {
  if (!(attempts >= 1)) return 0;
  // Past 7 doublings the cap is reached; the exponent is bounded so it never overflows.
  return Math.min(BACKFILL_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 16), BACKFILL_RETRY_MAX_MS);
}

/**
 * Whether a resume may upload now. A clock set back since the last attempt counts as due, or
 * the owed audio could wait for days.
 */
export function isBackfillRetryDue(retry: BackfillRetry, nowMs: number): boolean {
  if (nowMs < retry.lastAttemptAt) return true;
  return nowMs - retry.lastAttemptAt >= backfillRetryDelayMs(retry.attempts);
}

/** Rejects when it cannot be written, so the caller knows nothing on disk names the owed audio. */
export async function savePendingBackfill(
  noteId: number,
  windows: AudioWindow[],
  /** Absent for audio no resume has tried yet. */
  retry?: BackfillRetry,
): Promise<void> {
  const uri = meetingBackfillUri(noteId);
  await FileSystem.writeAsStringAsync(
    uri,
    JSON.stringify({
      version: PENDING_BACKFILL_VERSION,
      windows: windows.map(({ startMs, endMs }) => ({ startMs, endMs })),
      ...(retry ? { attempts: retry.attempts, lastAttemptAt: retry.lastAttemptAt } : {}),
    }),
  );
  // After every write: a file replaced on disk loses the mark.
  await excludeMeetingFileFromBackup(uri);
}

const isWindow = (value: unknown): value is AudioWindow => {
  const window = value as { startMs?: unknown; endMs?: unknown } | null;
  return (
    typeof window === 'object' &&
    window !== null &&
    typeof window.startMs === 'number' &&
    typeof window.endMs === 'number' &&
    Number.isFinite(window.startMs) &&
    Number.isFinite(window.endMs)
  );
};

// Written by this app, but a file from a damaged write must never block or crash a resume.
const nonNegativeNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** The saved windows and retry count, or null when there is no sidecar or it can't be trusted. */
export async function readPendingBackfillState(
  noteId: number,
): Promise<PendingBackfillState | null> {
  try {
    const uri = meetingBackfillUri(noteId);
    if (!(await FileSystem.getInfoAsync(uri)).exists) return null;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(uri)) as {
      version?: unknown;
      windows?: unknown;
      attempts?: unknown;
      lastAttemptAt?: unknown;
    } | null;
    if (parsed?.version !== PENDING_BACKFILL_VERSION || !Array.isArray(parsed.windows)) return null;
    if (!parsed.windows.every(isWindow)) return null;
    return {
      windows: parsed.windows.map(({ startMs, endMs }) => ({ startMs, endMs })),
      attempts: Math.floor(nonNegativeNumber(parsed.attempts)),
      lastAttemptAt: nonNegativeNumber(parsed.lastAttemptAt),
    };
  } catch {
    return null;
  }
}

/** The saved windows, or null when there is no sidecar or it can't be trusted. */
export async function readPendingBackfill(noteId: number): Promise<AudioWindow[] | null> {
  return (await readPendingBackfillState(noteId))?.windows ?? null;
}

/**
 * Whether a sidecar file is there, readable or not: one that can't be parsed still means the
 * recording owes audio. True when the answer can't be read, so a recording is never deleted on
 * a failed check.
 */
export async function hasPendingBackfillFile(noteId: number): Promise<boolean> {
  try {
    return (await FileSystem.getInfoAsync(meetingBackfillUri(noteId))).exists;
  } catch {
    return true;
  }
}

/** Idempotent; never throws. */
export async function clearPendingBackfill(noteId: number): Promise<void> {
  await FileSystem.deleteAsync(meetingBackfillUri(noteId), { idempotent: true }).catch(
    () => undefined,
  );
}

export function isWavAudioFile(input: {
  audioUrl?: string | null;
  audioFileName?: string | null;
  audioMimeType?: string | null;
}): boolean {
  const mime = input.audioMimeType?.trim().toLowerCase();
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave') return true;

  const fileName = input.audioFileName ?? input.audioUrl ?? '';
  const extension = fileName.split('?')[0]?.split('#')[0]?.split('.').pop()?.toLowerCase();
  return extension === 'wav' || extension === 'wave';
}

export function extensionForAudio(input: {
  audioUrl?: string | null;
  audioFileName?: string | null;
  audioMimeType?: string | null;
}): string {
  const mime = input.audioMimeType?.trim().toLowerCase();
  if (mime && MIME_EXTENSION[mime]) return MIME_EXTENSION[mime];

  const fileName = input.audioFileName ?? input.audioUrl ?? '';
  const extension = fileName.split('?')[0]?.split('#')[0]?.split('.').pop()?.toLowerCase();
  return extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'm4a';
}

export async function retainTranscriptAudio(
  sourceUri: string,
  input: {
    transcriptId: string;
    audioFileName?: string | null;
    audioMimeType?: string | null;
    keepSource?: boolean;
  },
): Promise<string> {
  if (!FileSystem.cacheDirectory) {
    if (input.keepSource) throw new Error('Audio cache unavailable');
    return sourceUri;
  }
  if (isManagedTranscriptAudioUri(sourceUri)) {
    return sourceUri;
  }

  const info = await FileSystem.getInfoAsync(sourceUri);
  if (!info.exists) {
    throw new Error('Audio file not found');
  }

  await FileSystem.makeDirectoryAsync(TRANSCRIPT_AUDIO_DIR, { intermediates: true });
  const extension = extensionForAudio({
    audioUrl: sourceUri,
    audioFileName: input.audioFileName,
    audioMimeType: input.audioMimeType,
  });
  const fileName = `${sanitizePathPart(input.transcriptId)}.${extension}`;
  const destinationUri = `${TRANSCRIPT_AUDIO_DIR}${fileName}`;

  await FileSystem.copyAsync({ from: sourceUri, to: destinationUri });
  // The keyboard outbox owns its source until History has persisted the retry row.
  if (!input.keepSource) {
    await FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => undefined);
  }
  return destinationUri;
}

export async function transcriptAudioExists(uri: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists;
}

export async function deleteManagedTranscriptAudio(uri?: string | null): Promise<void> {
  if (!isManagedTranscriptAudioUri(uri)) return;
  await FileSystem.deleteAsync(uri as string, { idempotent: true });
}

// Failed rows keep their audio so they can be retried; after this window the
// audio is dropped and the row becomes non-retryable, so an abandoned failure
// never holds audio on disk indefinitely.
export const RETAINED_AUDIO_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// Deletes every managed audio file not referenced by a surviving transcript.
// This reclaims both expired audio (whose row's uri was already cleared) and
// orphans left by a capture that was interrupted before its row was written.
// Safe to run at startup only, when no capture is in flight.
export async function garbageCollectTranscriptAudio(keepUris: Iterable<string>): Promise<void> {
  if (!FileSystem.cacheDirectory) return;
  const dirInfo = await FileSystem.getInfoAsync(TRANSCRIPT_AUDIO_DIR);
  if (!dirInfo.exists) return;

  const keep = new Set<string>();
  for (const uri of keepUris) {
    if (uri) keep.add(uri);
  }

  const files = await FileSystem.readDirectoryAsync(TRANSCRIPT_AUDIO_DIR);
  await Promise.all(
    files.map((name) => {
      const uri = `${TRANSCRIPT_AUDIO_DIR}${name}`;
      if (keep.has(uri)) return Promise.resolve();
      return FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    }),
  );
}
