/**
 * A dictation that addresses the assistant by name is cleaned like any other: the fused
 * transcribe-and-clean result is used as it is, with no second call to run it as a command.
 */
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { ReasoningService } from '@/services/reasoning/ReasoningService';

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

jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({
      text: `reasoned:${req.text}`,
      model: 'm',
    })),
  },
}));

jest.mock('@/lib/cleanupTranscript', () => ({
  cleanupTranscript: jest.fn(async (text: string) => `cleaned:${text}`),
  CLEANUP_TIMEOUT_MS: 12_000,
}));

jest.mock('@/lib/permissions', () => ({
  isNoSpeechError: jest.fn(() => false),
}));

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

// Mutable config for per-test control without jest.resetModules
let mockConfig: Record<string, unknown> = {
  defaultMode: 'cloud',
  cleanupEnabled: true,
};
let mockActiveMode = 'cloud';

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));

const mockFused = TranscriptionService.transcribeWithCloudCleanup as jest.Mock;
const mockTranscribe = TranscriptionService.transcribe as jest.Mock;
const mockReason = ReasoningService.processText as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveMode = 'cloud';
  mockConfig = { defaultMode: 'cloud', cleanupEnabled: true };
});

function fusedResult(rawText: string, cleanupApplied: boolean): Record<string, unknown> {
  return {
    text: cleanupApplied ? 'fused cleaned text' : rawText,
    originalText: rawText,
    provider: 'cloud',
    duration: 1,
    cleanupApplied,
    fusedCleanup: true,
  };
}

it.each(['keyboard', 'recording'] as const)(
  'keeps the fused cleanup of an addressed %s dictation, running no command',
  async (requestContext) => {
    mockFused.mockResolvedValue(
      fusedResult('hey OpenWhispr write a summary of this meeting', true),
    );

    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext,
    });

    expect(mockReason).not.toHaveBeenCalled();
    expect(result.text).toBe('fused cleaned text');
    expect(result.transcription.cleanupWarning).toBeUndefined();
  },
);

it('cleans an addressed dictation separately when fused cleanup did not apply', async () => {
  const rawText = 'hey OpenWhispr write a summary';
  mockFused.mockResolvedValue(fusedResult(rawText, false));

  const result = await transcribeAndCleanup({
    audioUri: 'file://a.wav',
    provider: 'cloud',
    requestContext: 'keyboard',
  });

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe(`cleaned:${rawText}`);
});

it('cleans a toned keyboard dictation serially, running no command', async () => {
  mockTranscribe.mockResolvedValue({
    text: 'hey OpenWhispr write a summary',
    provider: 'cloud',
    duration: 1,
  });

  await transcribeAndCleanup({
    audioUri: 'file://a.wav',
    provider: 'cloud',
    requestContext: 'keyboard',
    keyboardTone: 'formal',
  });

  expect(mockFused).not.toHaveBeenCalled();
  expect(mockReason).not.toHaveBeenCalled();
});
