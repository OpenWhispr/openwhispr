import { act, renderHook } from '@testing-library/react-native';
import { useAudioRecording } from '../useAudioRecording';

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
}));

// permissions.ts re-exports the alert helper, which reaches nativewind through
// the UI layer — untransformable here and irrelevant to the branch under test.
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));

const mockAddTranscript = jest.fn();
jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: jest.fn(() => 'test-id'),
  useTranscriptStore: (selector: (state: unknown) => unknown) =>
    selector({ addTranscript: mockAddTranscript, addFailedTranscript: jest.fn() }),
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
  isExpoAudioAvailable: () => true,
  getDefaultRecorderOptions: () => ({}),
}));

it('still delivers the transcript when history cannot be saved', async () => {
  mockAudioModule.getRecordingPermissionsAsync.mockResolvedValue({ granted: true });
  mockAudioModule.requestRecordingPermissionsAsync.mockResolvedValue({ granted: true });
  mockAddTranscript.mockRejectedValue(new Error('Transcript history is unavailable. Try again.'));
  const onComplete = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useAudioRecording({ onComplete, onError }));
  await act(async () => {
    await result.current.startRecording();
  });
  mockRecorder.isRecording = true;
  await act(async () => {
    await result.current.stopRecording().catch(() => undefined);
  });
  expect(onComplete).toHaveBeenCalledWith('Hello there.');
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('could not be saved') }),
  );
});
