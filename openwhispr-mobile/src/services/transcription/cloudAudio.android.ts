import { Platform } from 'react-native';
import { AudioTools, type ChunkResult } from '../../../modules/audio-tools/src';
import { abortError } from '../providers/NativeProviderTransport';

function androidAudio() {
  const { AndroidDictation } =
    require('../../../modules/android-dictation/src') as typeof import('../../../modules/android-dictation/src');
  if (!AndroidDictation) throw new Error('Android audio processing is unavailable.');
  return AndroidDictation;
}

// Cloud splitting has its own adapter so enabling it on Android does not change
// local speech, voice enrollment, or other users of the iOS AudioTools module.
export const CloudAudioTools = {
  isAvailable(): boolean {
    return Platform.OS === 'android' || AudioTools.isAvailable();
  },

  async splitToChunks(uri: string, seconds: number, signal?: AbortSignal): Promise<ChunkResult> {
    if (signal?.aborted) throw abortError('Transcription cancelled.');
    if (Platform.OS !== 'android') return AudioTools.splitToChunks(uri, seconds);

    const native = androidAudio();
    const id = native.prepareCloudAudio();
    const cancel = () => native.cancelCloudAudio(id);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await native.splitCloudAudio(uri, seconds, id);
      if (signal?.aborted) {
        await native.cleanupCloudAudio(result.chunks);
        throw abortError('Transcription cancelled.');
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortError('Transcription cancelled.');
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  },

  splitOggOpus(uri: string, maxBytes: number): Promise<ChunkResult> {
    return AudioTools.splitOggOpus(uri, maxBytes);
  },

  async cleanup(uris: string[]): Promise<void> {
    if (uris.length === 0) return;
    if (Platform.OS === 'android') await androidAudio().cleanupCloudAudio(uris);
    else await AudioTools.cleanup(uris);
  },
};
