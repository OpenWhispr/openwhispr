/**
 * Tests for agentName defensive path in transcribeAndCleanup:
 * - when fused result has cleanupApplied:true + mention detected → one serial reason call with agentName
 * - when fused result has cleanupApplied:true + no mention → no extra reason call
 * - when fused result has cleanupApplied:false → normal cleanup path (no extra reason call)
 * - when agent is disabled → no extra reason call even if mention detected
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
      text: `agent-action:${req.text}`,
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

describe('transcribeAndCleanup defensive agent path (fused cleanupApplied: true)', () => {
  it('makes one serial reason call with agentName when fused result has cleanupApplied:true + mention detected', async () => {
    mockConfig = {
      defaultMode: 'cloud',
      cleanupEnabled: true,
      dictationAgentEnabled: true,
      dictationAgentName: 'OpenWhispr',
    };

    const rawText = 'hey OpenWhispr write a summary of this meeting';
    mockFused.mockResolvedValue({
      text: 'fused cleaned text',
      originalText: rawText,
      provider: 'cloud',
      duration: 1,
      cleanupApplied: true,
      fusedCleanup: true,
    });

    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
    });

    expect(mockReason).toHaveBeenCalledTimes(1);
    const req = mockReason.mock.calls[0][0] as Record<string, unknown>;
    expect(req.agentName).toBe('OpenWhispr');
    expect(req.text).toBe(rawText);
    expect(result.text).toBe(`agent-action:${rawText}`);
  });

  it('does NOT make extra reason call when mention is NOT detected in the raw text', async () => {
    mockConfig = {
      defaultMode: 'cloud',
      cleanupEnabled: true,
      dictationAgentEnabled: true,
      dictationAgentName: 'OpenWhispr',
    };

    const rawText = 'just a regular dictation without the wake word';
    mockFused.mockResolvedValue({
      text: 'fused cleaned text',
      originalText: rawText,
      provider: 'cloud',
      duration: 1,
      cleanupApplied: true,
      fusedCleanup: true,
    });

    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
    });

    expect(mockReason).not.toHaveBeenCalled();
    expect(result.text).toBe('fused cleaned text');
  });

  it('does NOT make extra reason call when agent is disabled', async () => {
    mockConfig = {
      defaultMode: 'cloud',
      cleanupEnabled: true,
      dictationAgentEnabled: false,
    };

    const rawText = 'hey OpenWhispr write a summary';
    mockFused.mockResolvedValue({
      text: 'fused cleaned text',
      originalText: rawText,
      provider: 'cloud',
      duration: 1,
      cleanupApplied: true,
      fusedCleanup: true,
    });

    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
    });

    expect(mockReason).not.toHaveBeenCalled();
    expect(result.text).toBe('fused cleaned text');
  });

  it('does NOT make extra reason call when cleanupApplied is false on fused result', async () => {
    mockConfig = {
      defaultMode: 'cloud',
      cleanupEnabled: true,
      dictationAgentEnabled: true,
    };

    const rawText = 'hey OpenWhispr write a summary';
    mockFused.mockResolvedValue({
      text: rawText,
      originalText: rawText,
      provider: 'cloud',
      duration: 1,
      cleanupApplied: false,
      fusedCleanup: true,
    });

    const result = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
    });

    expect(mockReason).not.toHaveBeenCalled();
    expect(result.text).toBe(`cleaned:${rawText}`);
  });

  it('forces serial path (not fused) when tone is non-default — no defensive reason call', async () => {
    mockConfig = {
      defaultMode: 'cloud',
      cleanupEnabled: true,
      dictationAgentEnabled: true,
    };

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
});
