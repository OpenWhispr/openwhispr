import { act, renderHook } from '@testing-library/react-native';
import { useAudioRecording } from '../useAudioRecording';
import { acquireCaptureLease, releaseCaptureLease } from '@/lib/captureLease';

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

describe('useAudioRecording stopRecordingRaw', () => {
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

  it('returns the file of a recording that is capturing', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });

    let uri: string | null = null;
    await act(async () => {
      uri = await result.current.stopRecordingRaw();
    });

    expect(uri).toBe('file:///tmp/rec.wav');
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('returns the file of a paused recording', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    // A call or Siri paused the recorder.
    mockRecorder.isRecording = false;

    let uri: string | null = null;
    await act(async () => {
      uri = await result.current.stopRecordingRaw();
    });

    expect(uri).toBe('file:///tmp/rec.wav');
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('releases the lease only after a paused recorder has finished stopping', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    mockRecorder.isRecording = false;
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
    expect(releaseCaptureLease).not.toHaveBeenCalled();

    await act(async () => {
      finishStop();
      await stopped;
    });
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('returns the file when stopping a paused recorder throws', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    mockRecorder.isRecording = false;
    mockRecorder.stop.mockRejectedValue(new Error('nothing to stop'));

    let uri: string | null = null;
    await act(async () => {
      uri = await result.current.stopRecordingRaw();
    });

    expect(uri).toBe('file:///tmp/rec.wav');
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('still rejects when stopping a recording that is capturing throws', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    mockRecorder.stop.mockRejectedValue(new Error('stop failed'));

    await act(async () => {
      await expect(result.current.stopRecordingRaw()).rejects.toThrow('stop failed');
    });
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('returns null when nothing was recorded', async () => {
    const { result } = renderRecording(true);

    let uri: string | null = 'unset';
    await act(async () => {
      uri = await result.current.stopRecordingRaw();
    });

    expect(uri).toBeNull();
    expect(mockRecorder.stop).not.toHaveBeenCalled();
  });

  it('is safe to call twice', async () => {
    const { result } = renderRecording(true);
    await act(async () => {
      await result.current.startRecording();
    });
    mockRecorder.isRecording = false;

    let second: string | null = 'unset';
    await act(async () => {
      await result.current.stopRecordingRaw();
      second = await result.current.stopRecordingRaw();
    });

    expect(second).toBeNull();
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('cannot resume while a stop is in progress', async () => {
    const { result } = renderRecording(true);
    expect(result.current.canResumeRecording()).toBe(false);

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.canResumeRecording()).toBe(true);
    // Paused, as after a call: the stop is the path a resume could race with.
    mockRecorder.isRecording = false;
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
    expect(result.current.canResumeRecording()).toBe(false);

    await act(async () => {
      finishStop();
      await stopped;
    });
    expect(result.current.canResumeRecording()).toBe(false);
  });
});
