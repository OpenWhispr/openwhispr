import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { abortError } from '../providers/NativeProviderTransport';

export async function uploadTranscriptionAudio(
  url: string,
  audioUri: string,
  options: FileSystem.FileSystemUploadOptions,
  signal?: AbortSignal,
): Promise<FileSystem.FileSystemUploadResult> {
  if (signal?.aborted) throw abortError('Transcription cancelled.');
  // Keep the existing iOS session transport; Android needs an owned task to cancel.
  if (Platform.OS !== 'android' || !signal) return FileSystem.uploadAsync(url, audioUri, options);

  const task = FileSystem.createUploadTask(url, audioUri, options);
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
