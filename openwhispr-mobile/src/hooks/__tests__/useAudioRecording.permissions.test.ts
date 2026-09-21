import { act, renderHook } from '@testing-library/react-native';
import { useAudioRecording } from '../useAudioRecording';
import { isMicPermissionError } from '@/lib/permissions';

// The recording path pulls in expo-sqlite-backed stores and the whole
// transcription pipeline. None of it runs before the permission check, so mock
// it away and keep these tests on the one branch Apple rejected us over.
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn() }));

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

type PermissionState = { granted: boolean; canAskAgain: boolean };

/** Drives startRecording once and returns whatever reached the onError callback. */
async function startRecordingWith(
  prior: PermissionState,
  afterRequest: PermissionState,
): Promise<unknown> {
  mockAudioModule.getRecordingPermissionsAsync.mockResolvedValue(prior);
  mockAudioModule.requestRecordingPermissionsAsync.mockResolvedValue(afterRequest);

  let captured: unknown;
  const { result } = renderHook(() => useAudioRecording({ onError: (e) => (captured = e) }));
  // The granted path sets state, so drive it inside act to keep React quiet.
  await act(async () => {
    await result.current.startRecording().catch(() => undefined);
  });
  return captured;
}

describe('useAudioRecording microphone permission', () => {
  beforeEach(() => jest.clearAllMocks());

  it('always asks the system before deciding anything', async () => {
    await startRecordingWith(
      { granted: false, canAskAgain: true },
      { granted: false, canAskAgain: false },
    );

    expect(mockAudioModule.requestRecordingPermissionsAsync).toHaveBeenCalled();
  });

  // Guideline 5.1.1(iv): iOS prompts only once per install. When it did prompt,
  // the user's Deny is the answer — the app must not follow it with a
  // Settings-redirect alert, which is what got the build rejected.
  it('reports nativePromptShown when iOS could still display its dialog', async () => {
    const error = await startRecordingWith(
      { granted: false, canAskAgain: true },
      { granted: false, canAskAgain: false },
    );

    expect(isMicPermissionError(error)).toBe(true);
    expect((error as { nativePromptShown: boolean }).nativePromptShown).toBe(true);
  });

  it('reports no nativePromptShown once permission is permanently denied', async () => {
    const error = await startRecordingWith(
      { granted: false, canAskAgain: false },
      { granted: false, canAskAgain: false },
    );

    expect(isMicPermissionError(error)).toBe(true);
    expect((error as { nativePromptShown: boolean }).nativePromptShown).toBe(false);
  });

  it('starts recording without error once permission is granted', async () => {
    const error = await startRecordingWith(
      { granted: true, canAskAgain: false },
      { granted: true, canAskAgain: false },
    );

    expect(error).toBeUndefined();
    expect(mockRecorder.record).toHaveBeenCalled();
  });
});
