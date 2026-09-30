/**
 * A private-mode user who consents to "use Cloud once" gets a Cloud
 * transcription with its text stages re-pinned to OpenWhispr, while the
 * processing mode stays `private`. The serial cleanup pass must reach
 * ReasoningService without a privacy hint, or it would be treated as
 * local-required with no consent and fail, leaving the raw text.
 */
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { ReasoningService } from '@/services/reasoning/ReasoningService';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: {
    transcribe: jest.fn(),
    transcribeWithCloudCleanup: jest.fn(),
    canAttemptFusedCloudCleanup: jest.fn(() => false),
    requestNeedsChunking: jest.fn(async () => false),
    isFusedCleanupUnavailableError: jest.fn(() => false),
  },
  isLocalModelMissingError: jest.fn(() => false),
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({
      text: `cleaned:${req.text}`,
      model: 'm',
    })),
  },
}));
jest.mock('@/lib/permissions', () => ({
  isNoSpeechError: jest.fn(() => false),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { cleanupEnabled: true, defaultMode: 'private' } }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
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

const mockTranscribe = TranscriptionService.transcribe as jest.Mock;
const mockReason = ReasoningService.processText as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockTranscribe.mockResolvedValue({ text: 'um hello there', provider: 'cloud', duration: 1 });
});

it('cleans a consented Cloud fallback in private mode without a privacy hint', async () => {
  const result = await transcribeAndCleanup({
    audioUri: 'file://a.wav',
    provider: 'cloud',
    requestContext: 'recording',
    cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
    agentRoute: { mode: 'openwhispr', scope: 'agent' },
  });

  expect(mockReason).toHaveBeenCalledTimes(1);
  const req = mockReason.mock.calls[0][0] as Record<string, unknown>;
  expect(req.inferenceRoute).toEqual({ mode: 'openwhispr', scope: 'cleanup' });
  expect(req.routing).toBeUndefined();
  expect(result.text).toBe('cleaned:um hello there');
  expect(result.transcription.cleanupWarning).toBeUndefined();
});
