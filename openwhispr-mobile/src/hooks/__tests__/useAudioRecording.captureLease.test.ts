import { act, renderHook } from '@testing-library/react-native';
import { useAudioRecording } from '../useAudioRecording';
import { acquireCaptureLease, isCaptureLeaseHeld, releaseCaptureLease } from '@/lib/captureLease';

// The recording path pulls in expo-sqlite-backed stores and the whole transcription pipeline;
// mock it away so these tests stay on the capture lease.
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(async () => undefined),
}));

jest.mock('@/lib/captureLease', () => ({
  acquireCaptureLease: jest.fn(),
  releaseCaptureLease: jest.fn(),
  isCaptureLeaseHeld: jest.fn(() => false),
}));

// permissions.ts re-exports the alert helper, which reaches nativewind through
// the UI layer — untransformable here and irrelevant to the branch under test.
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));

jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: jest.fn(() => 'test-id'),
  useTranscriptStore: (selector: (state: unknown) => unknown) =>
    selector({ addTranscript: jest.fn(), addFailedTranscript: jest.fn() }),
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: unknown) => unknown) =>
    selector({ activeMode: 'cloud' }),
}));

jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: () => ({ provider: 'cloud' }),
}));

jest.mock('@/lib/transcribeAndCleanup', () => ({ transcribeAndCleanup: jest.fn() }));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  isLocalModelMissingError: jest.fn(() => false),
}));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: jest.fn(),
  createNoSpeechError: jest.fn(),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  retainTranscriptAudio: jest.fn(),
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
  isExpoAudioAvailable: () => true,
  getDefaultRecorderOptions: () => ({}),
}));

function renderRecording(allowsBackgroundRecording: boolean) {
  return renderHook(() => useAudioRecording({ allowsBackgroundRecording }));
}

describe('useAudioRecording capture lease', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockRecorder.isRecording = false;
    mockRecorder.prepareToRecordAsync.mockImplementation(async () => undefined);
    mockRecorder.stop.mockImplementation(async () => undefined);
    mockRecorder.record.mockImplementation(() => {
      mockRecorder.isRecording = true;
    });
    mockAudioModule.getRecordingPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
    mockAudioModule.requestRecordingPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
    (acquireCaptureLease as jest.Mock).mockResolvedValue(undefined);
  });

  it('acquires meeting-local before setAudioModeAsync', async () => {
    const order: string[] = [];
    (acquireCaptureLease as jest.Mock).mockImplementation(async () => {
      order.push('acquire');
    });
    mockAudioModule.setAudioModeAsync.mockImplementation(async () => {
      order.push('audioMode');
    });
    const { result } = renderRecording(true);

    await act(async () => {
      await result.current.startRecording();
    });

    expect(order).toEqual(['acquire', 'audioMode']);
    expect(acquireCaptureLease).toHaveBeenCalledWith('meeting-local');
  });

  describe('while a meeting holds the lease', () => {
    const REFUSAL = 'A meeting is being recorded. End it to dictate.';

    beforeEach(() => {
      (isCaptureLeaseHeld as jest.Mock).mockReturnValue(true);
    });
    afterEach(() => {
      (isCaptureLeaseHeld as jest.Mock).mockReturnValue(false);
    });

    it('refuses a dictation while a meeting holds the lease', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const onError = jest.fn();
      const { result } = renderHook(() => useAudioRecording({ onError }));

      let rejection: unknown;
      await act(async () => {
        await result.current.startRecording().catch((error: unknown) => {
          rejection = error;
        });
      });

      expect((rejection as Error).message).toBe(REFUSAL);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: REFUSAL }));
      expect(mockAudioModule.getRecordingPermissionsAsync).not.toHaveBeenCalled();
      expect(mockAudioModule.requestRecordingPermissionsAsync).not.toHaveBeenCalled();
      expect(mockAudioModule.setAudioModeAsync).not.toHaveBeenCalled();
      expect(mockRecorder.prepareToRecordAsync).not.toHaveBeenCalled();
    });

    it('a meeting start is not refused', async () => {
      const onError = jest.fn();
      const { result } = renderHook(() =>
        useAudioRecording({ allowsBackgroundRecording: true, onError }),
      );

      await act(async () => {
        await result.current.startRecording();
      });

      expect(onError).not.toHaveBeenCalled();
      expect(mockRecorder.record).toHaveBeenCalled();
    });
  });

  it('does not acquire for dictation', async () => {
    const { result } = renderRecording(false);

    await act(async () => {
      await result.current.startRecording();
    });
    mockRecorder.isRecording = true;
    await act(async () => {
      await result.current.cancelRecording();
    });

    expect(acquireCaptureLease).not.toHaveBeenCalled();
    expect(releaseCaptureLease).not.toHaveBeenCalled();
  });

  it('releases after stopRecordingRaw has stopped the recorder', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    let finishStop: () => void = () => undefined;
    mockRecorder.stop.mockReturnValue(
      new Promise<undefined>((resolve) => {
        finishStop = () => resolve(undefined);
      }),
    );

    let stopped: Promise<string | null> = Promise.resolve(null);
    await act(async () => {
      stopped = result.current.stopRecordingRaw();
      await Promise.resolve();
    });
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).not.toHaveBeenCalled();

    await act(async () => {
      finishStop();
      await stopped;
    });
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledWith('meeting-local');
  });

  it('releases after cancelRecording', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });

    await act(async () => {
      await result.current.cancelRecording();
    });

    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('releases when prepareToRecordAsync throws', async () => {
    mockRecorder.prepareToRecordAsync.mockRejectedValue(new Error('prepare failed'));
    // startRecording logs the failure it rethrows; keep that out of the test output.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderRecording(true);

    await act(async () => {
      await result.current.startRecording().catch(() => undefined);
    });

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledWith('meeting-local');
  });

  it('releases on unmount while recording', async () => {
    const { result, unmount } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    expect(releaseCaptureLease).not.toHaveBeenCalled();

    unmount();

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('releases when unmounted while the acquire is pending', async () => {
    let grant: () => void = () => undefined;
    (acquireCaptureLease as jest.Mock).mockReturnValue(
      new Promise<void>((resolve) => {
        grant = resolve;
      }),
    );
    const { result, unmount } = renderRecording(true);

    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let started: Promise<void> = Promise.resolve();
    await act(async () => {
      started = result.current.startRecording();
      started.catch(() => undefined);
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      grant();
      await started.catch(() => undefined);
    });

    await expect(started).rejects.toThrow('Recording was abandoned before it started');

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
    expect(mockAudioModule.setAudioModeAsync).not.toHaveBeenCalled();
    expect(mockRecorder.prepareToRecordAsync).not.toHaveBeenCalled();
  });

  it("a failed second start does not release the first recording's lease", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    mockRecorder.prepareToRecordAsync.mockRejectedValue(new Error('prepare refused'));

    await act(async () => {
      await result.current.startRecording().catch(() => undefined);
    });
    expect(acquireCaptureLease).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.stopRecordingRaw();
    });
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('releases once when a stop is followed by an unmount', async () => {
    const { result, unmount } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await result.current.stopRecordingRaw();
    });

    unmount();

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });
});
