import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { cleanupTranscript } from '@/lib/cleanupTranscript';

// accountAccess pulls in the router for its sign-in alert; stub it here.
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
}));

jest.mock('@/lib/permissions', () => ({
  isNoSpeechError: jest.fn(() => false),
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { cleanupEnabled: true } }) },
}));

// Snippets merged into this pipeline: transcribeAndCleanup now reads the snippet
// store (for final-text expansion) and dictationHints imports both stores. Mock
// them so importing the unit under test doesn't pull in the native expo-sqlite db.
// Empty entries → expansion is a no-op, keeping these tests focused on tone.
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));

jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));

// transcribeAndCleanup now imports ReasoningService for the defensive agent path.
// Mock it so expo/fetch doesn't bleed into this test suite.
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({ text: req.text, model: 'm' })),
  },
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));

const mockTranscribe = TranscriptionService.transcribe as jest.Mock;
const mockFused = TranscriptionService.transcribeWithCloudCleanup as jest.Mock;
const mockCleanup = cleanupTranscript as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockTranscribe.mockResolvedValue({ text: 'hello world', provider: 'cloud', duration: 1 });
});

describe('transcribeAndCleanup tone', () => {
  it('forces the serial path and passes tone for a non-default keyboard tone', async () => {
    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
      keyboardTone: 'formal',
    });

    expect(mockFused).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledWith('hello world', {
      tone: 'formal',
      includeSnippetTriggers: true,
      context: 'keyboard',
    });
    expect(result.text).toBe('cleaned:hello world');
  });

  it('does not pass tone for the default keyboard tone and may use fused', async () => {
    mockFused.mockResolvedValue({
      text: 'hi',
      originalText: 'hi',
      provider: 'cloud',
      duration: 1,
      cleanupApplied: true,
      fusedCleanup: true,
    });

    await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
      keyboardTone: 'default',
    });

    expect(mockFused).toHaveBeenCalled();
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it.each(['recording', 'file'] as const)(
    'does not force serial or pass tone for %s requests even if keyboardTone is present',
    async (requestContext) => {
      mockFused.mockResolvedValue({
        text: 'raw words',
        originalText: 'raw words',
        provider: 'cloud',
        duration: 1,
        cleanupApplied: false,
        fusedCleanup: true,
      });

      await transcribeAndCleanup({
        audioUri: 'file://a.wav',
        provider: 'cloud',
        requestContext,
        keyboardTone: 'formal',
      });

      expect(mockFused).toHaveBeenCalled();
      expect(mockTranscribe).not.toHaveBeenCalled();
      // Tone stays undefined for non-keyboard contexts; snippet expansion still
      // applies to dictation (recording) but not to file uploads.
      expect(mockCleanup).toHaveBeenCalledWith('raw words', {
        tone: undefined,
        includeSnippetTriggers: requestContext === 'recording',
        context: requestContext === 'recording' ? 'recording' : undefined,
      });
    },
  );
});
