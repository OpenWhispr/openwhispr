import * as FileSystem from 'expo-file-system/legacy';
import { act, renderHook } from '@testing-library/react-native';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { useAudioRecording as useIOSAudioRecording } from '../useAudioRecording';
import { useAudioRecording as useAndroidAudioRecording } from '../useAudioRecording.android';
import { Platform } from 'react-native';

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  deleteAsync: jest.fn(async () => undefined),
}));

// permissions.ts re-exports the alert helper, which reaches nativewind through
// the UI layer — untransformable here and irrelevant to the branch under test.
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));

const mockAddTranscript = jest.fn();
const mockAddFailedTranscript = jest.fn();
let mockAvailable = true;
jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: jest.fn(() => 'test-id'),
  useTranscriptStore: (selector: (state: unknown) => unknown) =>
    selector({ addTranscript: mockAddTranscript, addFailedTranscript: mockAddFailedTranscript }),
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: 'cloud' }),
}));

jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: () => ({ provider: 'cloud' }),
}));

jest.mock('@/lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: jest.fn(async () => ({
    text: 'Hello there.',
    originalText: 'hello there',
    transcription: { duration: 1, provider: 'cloud' },
  })),
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  isLocalModelMissingError: jest.fn(() => false),
}));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: jest.fn(async () => null),
  createNoSpeechError: jest.fn(),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  retainTranscriptAudio: jest.fn(async () => 'file:///docs/transcript-audio/test-id.wav'),
  deleteManagedTranscriptAudio: jest.fn(),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: jest.fn(() => 'en'),
}));

// jest hoists mock factories above the module body, so anything they close over
// has to be mock-prefixed to survive the hoist.
const mockRecorder = {
  isRecording: false,
  uri: 'file:///tmp/rec.wav',
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
};

const mockAudioModule = {
  getRecordingPermissionsAsync: jest.fn(),
  requestRecordingPermissionsAsync: jest.fn(),
  requestNotificationPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => undefined),
};

jest.mock('expo-audio', () => ({ useAudioRecorder: () => mockRecorder }));
jest.mock('@/utils/expoAudio', () => ({
  getExpoAudioModule: () => ({ AudioModule: mockAudioModule }),
  isExpoAudioAvailable: () => mockAvailable,
  getDefaultRecorderOptions: () => ({}),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockAvailable = true;
  mockRecorder.uri = 'file:///tmp/rec.wav';
  mockAddTranscript.mockResolvedValue(undefined);
  mockAddFailedTranscript.mockResolvedValue(undefined);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: true, size: 1024 } as never);
  jest.mocked(transcribeAndCleanup).mockResolvedValue({
    text: 'Hello there.',
    originalText: 'hello there',
    transcription: { duration: 1, provider: 'cloud' },
  } as never);
  mockRecorder.prepareToRecordAsync.mockResolvedValue(undefined);
  mockAudioModule.requestNotificationPermissionsAsync.mockResolvedValue({ granted: true });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockRecorder.isRecording = false;
  mockAudioModule.getRecordingPermissionsAsync.mockResolvedValue({ granted: true });
  mockAudioModule.requestRecordingPermissionsAsync.mockResolvedValue({ granted: true });
  mockRecorder.record.mockImplementation(() => {
    mockRecorder.isRecording = true;
  });
  mockRecorder.stop.mockImplementation(async () => {
    mockRecorder.isRecording = false;
  });
});

afterEach(() => jest.restoreAllMocks());
jest.mock('@/lib/uuid', () => ({ randomUUID: () => 'fixed-recording-id' }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.name, message: error.message }),
  );

describe.each([
  { platform: 'ios' as const, useRecording: useIOSAudioRecording, guarded: false },
  { platform: 'android' as const, useRecording: useAndroidAudioRecording, guarded: true },
])('$platform recording boundary', ({ platform, useRecording, guarded }) => {
  beforeEach(() => {
    Platform.OS = platform;
  });

  it('preserves the public API and successful Stop result', async () => {
    const onComplete = jest.fn();
    const { result } = renderHook(() => useRecording({ onComplete }));
    expect(Object.keys(result.current)).toEqual([
      ...(guarded ? ['isStarting'] : []),
      'isRecording',
      'isProcessing',
      'currentText',
      'isSupported',
      'startRecording',
      'stopRecording',
      'stopRecordingRaw',
      'cancelRecording',
      'audioRecorder',
    ]);
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      expect(await result.current.stopRecording()).toBe(guarded ? true : undefined);
    });
    expect(onComplete).toHaveBeenCalledWith('Hello there.');
    expect(result.current.currentText).toBe('Hello there.');
  });

  it('preserves an idle Stop result', async () => {
    const { result } = renderHook(() => useRecording());
    await act(async () => {
      expect(await result.current.stopRecording()).toBe(guarded ? false : undefined);
    });
    expect(mockRecorder.stop).not.toHaveBeenCalled();
  });

  it('preserves unavailable-native Start errors', async () => {
    mockAvailable = false;
    const onError = jest.fn();
    const { result } = renderHook(() => useRecording({ onError }));
    await act(async () => {
      await expect(result.current.startRecording()).rejects.toThrow(
        guarded
          ? 'Audio recording is unavailable in this build. Install the full app to record.'
          : 'Audio recording is unavailable in Expo Go. Build and run a development client (e.g. `expo run:ios`) to test recording features.',
      );
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('preserves unavailable-native idle Stop handling', async () => {
    mockAvailable = false;
    const onError = jest.fn();
    const { result } = renderHook(() => useRecording({ onError }));
    await act(async () => {
      if (guarded) expect(await result.current.stopRecording()).toBe(false);
      else
        await expect(result.current.stopRecording()).rejects.toThrow(
          'Audio recording is unavailable in Expo Go.',
        );
    });
    expect(onError).toHaveBeenCalledTimes(guarded ? 0 : 1);
  });

  it('preserves microphone denial and prompt metadata', async () => {
    mockAudioModule.getRecordingPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    });
    mockAudioModule.requestRecordingPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
    const onError = jest.fn();
    const { result } = renderHook(() => useRecording({ onError }));
    await act(async () => {
      await expect(result.current.startRecording()).rejects.toMatchObject({
        nativePromptShown: true,
        canAskAgain: false,
      });
    });
    expect(mockRecorder.record).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('preserves background notification permission handling', async () => {
    mockAudioModule.requestNotificationPermissionsAsync.mockResolvedValue({ granted: false });
    const { result } = renderHook(() => useRecording({ allowsBackgroundRecording: true }));
    await act(async () => {
      if (guarded)
        await expect(result.current.startRecording()).rejects.toThrow(
          'Notification permission is required',
        );
      else await result.current.startRecording();
    });
    expect(mockAudioModule.requestNotificationPermissionsAsync).toHaveBeenCalledTimes(
      guarded ? 1 : 0,
    );
    expect(mockRecorder.record).toHaveBeenCalledTimes(guarded ? 0 : 1);
  });

  it('preserves missing-file errors', async () => {
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: false } as never);
    const { result } = renderHook(() => useRecording());
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await expect(result.current.stopRecording()).rejects.toThrow(
        guarded
          ? 'Recording file was not created. Please try recording again.'
          : 'Recording file was not created. Audio recording may not work in the iOS Simulator. Please try on a physical device.',
      );
    });
    expect(transcribeAndCleanup).not.toHaveBeenCalled();
  });

  it('preserves failed-history request identity', async () => {
    jest.mocked(transcribeAndCleanup).mockRejectedValue(new Error('Response lost'));
    const { result } = renderHook(() => useRecording());
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await expect(result.current.stopRecording()).rejects.toThrow('Response lost');
    });
    const saved = mockAddFailedTranscript.mock.calls[0][0];
    expect(Object.hasOwn(saved, 'clientTranscriptionId')).toBe(guarded);
    if (guarded) expect(saved.clientTranscriptionId).toBe('recording-fixed-recording-id');
  });

  it('preserves duplicate Start while permission is pending', async () => {
    const permission = deferred<{ granted: boolean }>();
    mockAudioModule.requestRecordingPermissionsAsync.mockReturnValueOnce(permission.promise);
    const { result } = renderHook(() => useRecording());
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = settle(result.current.startRecording());
    });
    await act(async () => {
      if (guarded)
        await expect(result.current.startRecording()).rejects.toMatchObject({ name: 'AbortError' });
      else await result.current.startRecording();
    });
    await act(async () => {
      permission.resolve({ granted: true });
      await pending;
    });
    expect(mockRecorder.record).toHaveBeenCalledTimes(guarded ? 1 : 2);
  });

  it.each(['cancel', 'unmount', 'prepare', 'record'] as const)(
    'preserves pending-start %s behavior',
    async (stage) => {
      const pause = deferred<undefined>();
      if (stage === 'prepare') mockRecorder.prepareToRecordAsync.mockReturnValueOnce(pause.promise);
      else if (stage === 'record')
        mockRecorder.record.mockImplementationOnce(() => {
          mockRecorder.isRecording = true;
          return pause.promise;
        });
      else
        mockAudioModule.requestRecordingPermissionsAsync.mockImplementationOnce(async () => {
          await pause.promise;
          return { granted: true };
        });
      const onError = jest.fn();
      const { result, unmount } = renderHook(() => useRecording({ onError }));
      let pending!: Promise<unknown>;
      await act(async () => {
        pending = settle(result.current.startRecording());
      });
      if (stage === 'unmount') unmount();
      else
        await act(async () => {
          await result.current.cancelRecording();
        });
      await act(async () => {
        pause.resolve(undefined);
        expect(await pending).toEqual(
          guarded ? { error: 'AbortError', message: 'Recording cancelled' } : { value: undefined },
        );
      });
      expect(onError).not.toHaveBeenCalled();
      expect(mockRecorder.record).toHaveBeenCalledTimes(guarded && stage !== 'record' ? 0 : 1);
      if (stage === 'prepare')
        expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(guarded ? 1 : 0);
    },
  );

  it('preserves processing state and raw Stop during native Stop', async () => {
    const nativeStop = deferred<undefined>();
    mockRecorder.stop.mockReturnValueOnce(nativeStop.promise);
    const { result } = renderHook(() => useRecording());
    await act(async () => {
      await result.current.startRecording();
    });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.stopRecording();
    });
    expect(result.current.isProcessing).toBe(guarded);
    await act(async () => {
      expect(await result.current.stopRecordingRaw()).toBe(guarded ? null : mockRecorder.uri);
    });
    await act(async () => {
      nativeStop.resolve(undefined);
      await pending;
    });
    expect(mockRecorder.stop).toHaveBeenCalledTimes(guarded ? 1 : 2);
  });

  it('preserves Start during transcription', async () => {
    const transcription = deferred<Awaited<ReturnType<typeof transcribeAndCleanup>>>();
    jest.mocked(transcribeAndCleanup).mockReturnValueOnce(transcription.promise);
    const { result } = renderHook(() => useRecording());
    await act(async () => {
      await result.current.startRecording();
    });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.stopRecording();
    });
    expect(result.current.isProcessing).toBe(true);
    await act(async () => {
      if (guarded)
        await expect(result.current.startRecording()).rejects.toMatchObject({ name: 'AbortError' });
      else await result.current.startRecording();
    });
    await act(async () => {
      transcription.resolve({
        text: 'Saved.',
        originalText: 'Saved.',
        transcription: { provider: 'cloud' },
      } as never);
      await pending;
    });
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(guarded ? 1 : 2);
  });
});
