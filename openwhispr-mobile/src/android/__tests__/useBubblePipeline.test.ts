import { renderHook } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { processAndroidAudio, createAndroidJob, AndroidCleanupError } from '../pipeline';
import { useBubbleResult } from '../bubbleResult';
import { useBubblePipeline } from '../useBubblePipeline';

type Listener = (event?: any) => unknown;
const mockListeners: Record<string, Listener> = {};
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { setStatus: jest.fn(async () => {}), insert: jest.fn(async () => true) },
  dictationEvents: {
    addListener: (event: string, listener: Listener) => {
      mockListeners[event] = listener;
      return { remove: jest.fn() };
    },
  },
}));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn(async () => {}) }));
jest.mock('expo-router', () => ({ router: { navigate: jest.fn() } }));
jest.mock('@/lib/transcriptScope', () => ({ observeTranscriptScope: () => () => {} }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: {} }) },
}));
jest.mock('../strings', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('../practiceSession', () => ({
  usePracticeSession: { getState: () => ({ complete: jest.fn() }) },
}));
jest.mock('../pipeline', () => {
  class CleanupError extends Error {
    transcript: string;
    constructor(message: string, text: string) {
      super(message);
      this.transcript = text;
    }
  }
  return {
    AndroidCleanupError: CleanupError,
    createAndroidJob: jest.fn((mode: string) => ({ mode })),
    processAndroidAudio: jest.fn(),
  };
});

const audio = { uri: 'file:///cache/dictation-1.wav', durationMs: 2000, noSpeech: false };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const native = AndroidDictation as unknown as { setStatus: jest.Mock; insert: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  useBubbleResult.getState().dismiss();
  renderHook(() => useBubblePipeline());
});

it('always dictates, even over highlighted text', async () => {
  jest.mocked(processAndroidAudio).mockResolvedValue('Tomorrow at 4 works.');
  mockListeners.onStart({ selection: 'old words', mode: 'edit' });
  expect(createAndroidJob).toHaveBeenCalledWith('dictate', 'Spanish', 'old words');
  mockListeners.onRecording(audio);
  await flush();
  expect(native.insert).toHaveBeenCalledWith('Tomorrow at 4 works.');
  expect(native.setStatus).toHaveBeenLastCalledWith('success');
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audio.uri, { idempotent: true });
});

it('keeps a failed recording so Retry sends the same audio again, then deletes it', async () => {
  jest.mocked(processAndroidAudio).mockRejectedValueOnce(new Error('Network down'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry-kept');
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  expect(useBubbleResult.getState().error).toBe('Network down');

  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Hello there.');
  mockListeners.onRetry({ selection: '' });
  await flush();
  expect(jest.mocked(processAndroidAudio).mock.calls[1][0]).toBe(audio);
  expect(native.insert).toHaveBeenCalledWith('Hello there.');
  expect(native.setStatus).toHaveBeenLastCalledWith('success');
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audio.uri, { idempotent: true });
});

it('deletes a kept recording when the error is dismissed', async () => {
  jest.mocked(processAndroidAudio).mockRejectedValueOnce(new Error('Network down'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  mockListeners.onDismiss();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audio.uri, { idempotent: true });
  mockListeners.onRetry({ selection: '' });
  expect(native.setStatus).toHaveBeenLastCalledWith('retry');
});

it('asks for a new recording after silence instead of keeping it', async () => {
  jest.mocked(processAndroidAudio).mockRejectedValueOnce(new Error('noSpeech'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording({ ...audio, noSpeech: true });
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry');
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
});

it('offers the saved text when insertion fails or cleanup needs recovery', async () => {
  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Kept words');
  native.insert.mockResolvedValueOnce(false);
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('recover');
  expect(useBubbleResult.getState()).toMatchObject({
    text: 'Kept words',
    error: 'insertionFailed',
  });

  jest
    .mocked(processAndroidAudio)
    .mockRejectedValueOnce(new AndroidCleanupError('cleanup failed', 'raw words'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('recover');
  expect(useBubbleResult.getState()).toMatchObject({ text: 'raw words', error: 'cleanupRecovery' });
});
