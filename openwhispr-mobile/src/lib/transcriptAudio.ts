import * as FileSystem from 'expo-file-system/legacy';

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

/** source_file is synced metadata, not authority to read or delete a local path. */
export function isManagedMeetingAudioUri(noteId: number, uri?: string | null): boolean {
  return (
    !!FileSystem.documentDirectory && uri === `${FileSystem.documentDirectory}meeting-${noteId}.wav`
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
  },
): Promise<string> {
  if (!FileSystem.cacheDirectory) {
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
  // The source is a transient capture/cache file that is no longer needed once
  // the audio lives in managed storage. Drop it so a retained copy never leaves
  // a duplicate behind (best-effort: a lost race just leaves a purgeable file).
  await FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => undefined);
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
