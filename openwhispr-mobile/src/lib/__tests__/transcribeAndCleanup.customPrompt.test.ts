/**
 * A custom cleanup prompt is injected via /api/reason, which only the serial
 * cleanup pass calls; the fused /api/transcribe cleanup accepts flags only. So
 * an active override must force the serial path, like a non-default tone does.
 */
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { cleanupTranscript } from '@/lib/cleanupTranscript';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
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
jest.mock('@/lib/cleanupTranscript', () => ({
  cleanupTranscript: jest.fn(async (text: string) => `cleaned:${text}`),
  CLEANUP_TIMEOUT_MS: 12_000,
  AGENT_ACTION_TIMEOUT_MS: 30_000,
}));
jest.mock('@/lib/permissions', () => ({
  isNoSpeechError: jest.fn(() => false),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { cleanupEnabled: true, defaultMode: 'cloud' } }) },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({ text: req.text, model: 'm' })),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));

let mockCustomPrompt: string | undefined = 'Always use bullet points.';
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => mockCustomPrompt,
}));

const mockTranscribe = TranscriptionService.transcribe as jest.Mock;
const mockFused = TranscriptionService.transcribeWithCloudCleanup as jest.Mock;
const mockCleanup = cleanupTranscript as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomPrompt = 'Always use bullet points.';
  mockTranscribe.mockResolvedValue({ text: 'hello world', provider: 'cloud', duration: 1 });
  mockFused.mockResolvedValue({
    text: 'hello world',
    originalText: 'hello world',
    provider: 'cloud',
    duration: 1,
    cleanupApplied: true,
    fusedCleanup: true,
  });
});

describe('transcribeAndCleanup with a custom cleanup prompt', () => {
  it.each(['keyboard', 'recording', 'file'] as const)(
    'forces the serial path for %s requests',
    async (requestContext) => {
      const result = await transcribeAndCleanup({
        audioUri: 'file://a.wav',
        provider: 'cloud',
        requestContext,
        keyboardTone: 'default',
      });

      expect(mockFused).not.toHaveBeenCalled();
      expect(mockTranscribe).toHaveBeenCalled();
      expect(mockCleanup).toHaveBeenCalledWith('hello world', expect.any(Object));
      expect(result.text).toBe('cleaned:hello world');
    },
  );

  it('keeps the fused path when no override is set', async () => {
    mockCustomPrompt = undefined;
    await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'recording',
    });
    expect(mockFused).toHaveBeenCalled();
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it('never cleans a local transcript, override or not', async () => {
    mockTranscribe.mockResolvedValue({ text: 'local words', provider: 'local', duration: 1 });
    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'local',
      requestContext: 'recording',
    });
    expect(mockFused).not.toHaveBeenCalled();
    expect(mockCleanup).not.toHaveBeenCalled();
    expect(result.text).toBe('local words');
  });
});
