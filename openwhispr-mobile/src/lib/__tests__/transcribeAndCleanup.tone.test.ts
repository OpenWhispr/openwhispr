import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { cleanupTranscript } from '@/lib/cleanupTranscript';
import { Platform } from 'react-native';

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

let mockConfig: Record<string, unknown> = { cleanupEnabled: true };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

// Snippets merged into this pipeline: transcribeAndCleanup now reads the snippet
// store (for final-text expansion) and dictationHints imports both stores. Mock
// them so importing the unit under test doesn't pull in the native expo-sqlite db.
// Empty entries → expansion is a no-op, keeping these tests focused on tone.
let mockUser = { id: 'u', isAnonymous: false };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
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

let mockActiveMode = 'cloud';
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));

const PROVIDER_ROUTE = {
  mode: 'providers' as const,
  scope: 'cleanup' as const,
  providerId: 'groq',
  modelId: 'llama',
  endpoint: 'https://api.groq.com/openai/v1',
};

const mockTranscribe = TranscriptionService.transcribe as jest.Mock;
const mockFused = TranscriptionService.transcribeWithCloudCleanup as jest.Mock;
const mockCleanup = cleanupTranscript as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'u', isAnonymous: false };
  mockActiveMode = 'cloud';
  mockConfig = { cleanupEnabled: true };
  mockTranscribe.mockResolvedValue({ text: 'hello world', provider: 'cloud', duration: 1 });
});

describe('transcribeAndCleanup tone', () => {
  it.each(['private', 'cloud'])(
    'keeps Android Style for local cleanup in %s mode',
    async (mode) => {
      const originalPlatform = Platform.OS;
      Platform.OS = 'android';
      try {
        mockActiveMode = mode;
        const cleanupRoute = { mode: 'local', scope: 'cleanup' } as const;
        mockConfig = { cleanupEnabled: true, inference: { cleanup: { mode: 'local' } } };
        mockTranscribe.mockResolvedValue({ text: 'hello world', provider: 'local', duration: 1 });

        await transcribeAndCleanup({
          audioUri: 'file://a.wav',
          provider: 'local',
          requestContext: 'keyboard',
          keyboardTone: 'formal',
          cleanupRoute,
        });

        expect(mockCleanup).toHaveBeenCalledWith(
          'hello world',
          expect.objectContaining({ tone: 'formal', inferenceRoute: cleanupRoute }),
        );
        expect(mockFused).not.toHaveBeenCalled();
      } finally {
        Platform.OS = originalPlatform;
      }
    },
  );

  it('forces the serial path and passes tone for a non-default keyboard tone', async () => {
    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
      keyboardTone: 'formal',
    });

    expect(mockFused).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledWith(
      'hello world',
      expect.objectContaining({
        tone: 'formal',
        includeSnippetTriggers: true,
        context: 'keyboard',
      }),
    );
    expect(result.text).toBe('cleaned:hello world');
  });

  // /api/reason refuses anonymous sessions, so forcing the serial path would drop cleanup
  // entirely. The fused pass still cleans; the tone waits for a real account.
  it('keeps fused cleanup for an anonymous session with a non-default tone', async () => {
    mockUser = { id: 'anon', isAnonymous: true };
    mockFused.mockResolvedValue({
      text: 'Hello world.',
      originalText: 'hello world',
      provider: 'cloud',
      duration: 1,
      cleanupApplied: true,
      fusedCleanup: true,
    });

    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
      keyboardTone: 'formal',
    });

    expect(mockFused).toHaveBeenCalled();
    expect(result.text).toBe('Hello world.');
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
      expect(mockCleanup).toHaveBeenCalledWith(
        'raw words',
        expect.objectContaining({
          tone: undefined,
          includeSnippetTriggers: requestContext === 'recording',
          context: requestContext === 'recording' ? 'recording' : undefined,
        }),
      );
    },
  );

  // Tones are a Cloud cleanup option, so a tone picked before Private mode never reaches its
  // cleanup, and On-Device cleanup never gets one.
  it.each([
    ['a cleanup provider in Local Mode', 'private', PROVIDER_ROUTE],
    [
      'On-Device cleanup in Local Mode',
      'private',
      { mode: 'local' as const, scope: 'cleanup' as const },
    ],
    [
      'On-Device cleanup outside Local Mode',
      'cloud',
      { mode: 'local' as const, scope: 'cleanup' as const },
    ],
  ])('passes no tone to %s', async (_label, activeMode, cleanupRoute) => {
    mockActiveMode = activeMode;
    mockConfig = { cleanupEnabled: true, inference: { cleanup: { mode: cleanupRoute.mode } } };
    mockTranscribe.mockResolvedValue({ text: 'hello world', provider: 'local', duration: 1 });

    await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'local',
      requestContext: 'keyboard',
      keyboardTone: 'formal',
      cleanupRoute,
    });

    expect(mockCleanup).toHaveBeenCalledWith(
      'hello world',
      expect.objectContaining({ tone: undefined, inferenceRoute: cleanupRoute }),
    );
  });

  it('passes the tone to a cleanup provider outside Local Mode', async () => {
    mockActiveMode = 'providers';

    await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
      keyboardTone: 'formal',
      cleanupRoute: PROVIDER_ROUTE,
    });

    expect(mockCleanup).toHaveBeenCalledWith(
      'hello world',
      expect.objectContaining({ tone: 'formal', inferenceRoute: PROVIDER_ROUTE }),
    );
  });
});
