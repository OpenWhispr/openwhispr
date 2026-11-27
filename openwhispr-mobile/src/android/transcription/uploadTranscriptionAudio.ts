import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { abortError } from '@/services/providers/NativeProviderTransport';
import { dlog, isDebugLogging } from '@/android/lib/debugLog';

let uploadRun: string | null = null;
/**
 * The debug-log run id (`u-…`) of the audio upload in progress, set by the upload hook, so the
 * transport's progress and split lines carry it. Dictation's uploads run without one and log nothing here.
 */
export function setUploadDebugRun(run: string | null): void {
  uploadRun = run;
}
export function uploadDebugRun(): string | undefined {
  return uploadRun ?? undefined;
}

/** Logs 25/50/75/100 % once each, only while an upload run is set and the log is on. */
function progressLogger():
  | FileSystem.FileSystemNetworkTaskProgressCallback<FileSystem.UploadProgressData>
  | undefined {
  const run = uploadRun;
  if (!run || !isDebugLogging()) return undefined;
  let logged = 0;
  return ({ totalBytesSent, totalBytesExpectedToSend }) => {
    try {
      if (!totalBytesExpectedToSend) return;
      const percent = Math.floor((totalBytesSent / totalBytesExpectedToSend) * 4) * 25;
      if (percent <= logged) return;
      logged = percent;
      dlog.info('upload', 'progress', { run, percent, bytes: totalBytesExpectedToSend });
    } catch {
      /* The log must never break an upload. */
    }
  };
}

export async function uploadTranscriptionAudio(
  url: string,
  audioUri: string,
  options: FileSystem.FileSystemUploadOptions,
  signal?: AbortSignal,
): Promise<FileSystem.FileSystemUploadResult> {
  if (signal?.aborted) throw abortError('Transcription cancelled.');
  // Keep the existing iOS session transport; Android needs an owned task to cancel.
  if (Platform.OS !== 'android' || !signal) return FileSystem.uploadAsync(url, audioUri, options);

  const progress = progressLogger();
  const task = progress
    ? FileSystem.createUploadTask(url, audioUri, options, progress)
    : FileSystem.createUploadTask(url, audioUri, options);
  const abort = () => {
    void task.cancelAsync().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await task.uploadAsync();
    if (signal.aborted || !response) throw abortError('Transcription cancelled.');
    return response;
  } catch (error) {
    if (signal.aborted) throw abortError('Transcription cancelled.');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
