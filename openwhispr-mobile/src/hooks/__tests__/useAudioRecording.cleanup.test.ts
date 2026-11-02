/**
 * A recording made with `cleanup: false` (a spoken chat question) runs the real routing and
 * transcription pipeline but gets its transcript back as heard: no fused or separate cleanup
 * request, no snippet expansion, and in Local Mode no trip to the Cloud cleanup it defaults to.
 */
import { act, renderHook } from '@testing-library/react-native';
import { useAudioRecording, type UseAudioRecordingOptions } from '../useAudioRecording';
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { ReasoningService } from '@/services/reasoning/ReasoningService';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));
jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: jest.fn(() => 'test-id'),
  useTranscriptStore: (selector: (state: unknown) => unknown) =>
    selector({ addTranscript: jest.fn(async () => undefined), addFailedTranscript: jest.fn() }),
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: {
    transcribe: jest.fn(),
    transcribeWithCloudCleanup: jest.fn(),
    canAttemptFusedCloudCleanup: jest.fn(() => true),
    requestNeedsChunking: jest.fn(async () => false),
    isFusedCleanupUnavailableError: jest.fn(() => false),
  },
  isLocalModelMissingError: jest.fn(() => false),
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (request: { text: string }) => ({
      text: `Cleaned: ${request.text}`,
      model: 'm',
    })),
  },
}));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: jest.fn(async () => null),
  createNoSpeechError: jest.fn(() => new Error('No speech detected')),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  retainTranscriptAudio: jest.fn(async () => 'file:///docs/transcript-audio/test-id.wav'),
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: jest.fn(() => 'en'),
}));

let mockActiveMode: 'cloud' | 'private' = 'cloud';
let mockConfig: Record<string, unknown> = {};
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'u', isAnonymous: false }, sessionCookie: 'session' }),
  },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: {
    getState: () => ({
      isLoaded: true,
      entries: [{ trigger: 'sig', replacement: 'Kind regards' }],
    }),
  },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));

const mockRecorder = {
  isRecording: false,
  uri: 'file:///tmp/rec.wav',
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
};
const mockAudioModule = {
  getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestNotificationPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => undefined),
};
jest.mock('expo-audio', () => ({ useAudioRecorder: () => mockRecorder }));
jest.mock('@/utils/expoAudio', () => ({
  getExpoAudioModule: () => ({ AudioModule: mockAudioModule }),
  isExpoAudioAvailable: () => true,
  getDefaultRecorderOptions: () => ({}),
}));

const mockTranscribe = jest.mocked(TranscriptionService.transcribe);
const mockFusedCleanup = jest.mocked(TranscriptionService.transcribeWithCloudCleanup);
const mockReason = jest.mocked(ReasoningService.processText);

const HEARD = 'um what is my sig';

async function recordAndStop(options: UseAudioRecordingOptions): Promise<jest.Mock> {
  const onComplete = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() =>
    useAudioRecording({ saveToHistory: false, onComplete, onError, ...options }),
  );
  await act(async () => {
    await result.current.startRecording();
  });
  mockRecorder.isRecording = true;
  await act(async () => {
    await result.current.stopRecording();
  });
  expect(onError).not.toHaveBeenCalled();
  return onComplete;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecorder.isRecording = false;
  mockActiveMode = 'cloud';
  mockConfig = { cleanupEnabled: true, defaultMode: 'cloud', inference: {} };
  mockTranscribe.mockResolvedValue({ text: HEARD, provider: 'cloud', duration: 1 });
  mockFusedCleanup.mockResolvedValue({
    text: 'What is my sig?',
    originalText: HEARD,
    cleanupApplied: true,
    provider: 'cloud',
    duration: 1,
  });
});

describe('a Cloud recording', () => {
  it('is cleaned and has its snippets expanded by default', async () => {
    const onComplete = await recordAndStop({});

    expect(mockFusedCleanup).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('What is my Kind regards?');
  });

  it('comes back as heard without cleanup', async () => {
    const onComplete = await recordAndStop({ cleanup: false });

    expect(mockFusedCleanup).not.toHaveBeenCalled();
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockReason).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(HEARD);
  });
});

// With nothing saved for cleanup, Local Mode cleans an On-Device transcript on OpenWhispr Cloud.
describe('a Local Mode recording with nothing saved for cleanup', () => {
  beforeEach(() => {
    mockActiveMode = 'private';
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    };
    mockTranscribe.mockResolvedValue({ text: HEARD, provider: 'local', duration: 1 });
  });

  it('is cleaned on OpenWhispr Cloud by default', async () => {
    const onComplete = await recordAndStop({});

    expect(mockReason).toHaveBeenCalledTimes(1);
    expect(mockReason.mock.calls[0][0]).toEqual(
      expect.objectContaining({ inferenceRoute: { mode: 'openwhispr', scope: 'cleanup' } }),
    );
    expect(onComplete).toHaveBeenCalledWith(`Cleaned: ${HEARD}`.replace('sig', 'Kind regards'));
  });

  it('stays on this iPhone and comes back as heard without cleanup', async () => {
    const onComplete = await recordAndStop({ cleanup: false });

    expect(mockTranscribe).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local' }));
    expect(mockFusedCleanup).not.toHaveBeenCalled();
    expect(mockReason).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(HEARD);
  });
});
