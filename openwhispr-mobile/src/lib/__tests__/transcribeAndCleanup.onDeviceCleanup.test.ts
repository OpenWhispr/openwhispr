/**
 * A transcript made on this phone is cleaned only when the user chose On-Device
 * cleanup, and then only by Apple Intelligence on this phone. Any other cleanup
 * choice would send it off the device, so the raw transcript is kept.
 */
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { countLocalReasoningTokens, getLocalReasoningReadiness } from '@/lib/localReasoning';

let mockConfig: Record<string, unknown> = {};
let mockActiveMode = 'private';
let mockCustomPrompt: string | undefined;

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
jest.mock('@/lib/localReasoning', () => ({
  ...jest.requireActual('@/lib/localReasoning'),
  getLocalReasoningReadiness: jest.fn(),
  countLocalReasoningTokens: jest.fn(),
}));
jest.mock('@/lib/permissions', () => ({
  isNoSpeechError: jest.fn(() => false),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => mockCustomPrompt,
}));

const mockTranscribe = TranscriptionService.transcribe as jest.Mock;
const mockReason = ReasoningService.processText as jest.Mock;
const mockReadiness = getLocalReasoningReadiness as jest.Mock;
const mockCountTokens = countLocalReasoningTokens as jest.Mock;

function transcribeOnDevice(
  lifecycle?: Parameters<typeof transcribeAndCleanup>[1],
): ReturnType<typeof transcribeAndCleanup> {
  return transcribeAndCleanup(
    {
      audioUri: 'file://a.wav',
      provider: 'local',
      requestContext: 'recording',
    },
    lifecycle,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveMode = 'private';
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
  };
  mockTranscribe.mockResolvedValue({ text: 'um hello there', provider: 'local', duration: 1 });
  mockReadiness.mockResolvedValue({ status: 'ready', tokenCounting: true });
  mockCountTokens.mockResolvedValue(null);
  mockCustomPrompt = undefined;
});

it('cleans an On-Device transcript on this phone when cleanup is set to On-Device', async () => {
  const result = await transcribeOnDevice();

  expect(mockReason).toHaveBeenCalledTimes(1);
  const req = mockReason.mock.calls[0][0] as Record<string, unknown>;
  expect(req.inferenceRoute).toEqual({ mode: 'local', scope: 'cleanup' });
  expect(req.routing).toEqual({ isPrivateNote: true });
  expect(result.text).toBe('cleaned:um hello there');
  expect(result.originalText).toBe('um hello there');
  expect(result.cleanupApplied).toBe(true);
});

it('cleans an On-Device upload on this phone outside On-Device mode too', async () => {
  mockActiveMode = 'cloud';
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'cloud',
    inference: { upload: { mode: 'local' }, cleanup: { mode: 'local' } },
  };

  const result = await transcribeAndCleanup({
    audioUri: 'file://a.wav',
    provider: 'local',
    requestContext: 'file',
  });

  expect(mockReason).toHaveBeenCalledTimes(1);
  expect((mockReason.mock.calls[0][0] as Record<string, unknown>).inferenceRoute).toEqual({
    mode: 'local',
    scope: 'cleanup',
  });
  expect(result.text).toBe('cleaned:um hello there');
});

it.each([
  ['OpenWhispr Cloud', { mode: 'openwhispr' }],
  ['a provider', { mode: 'providers', providerId: 'openai', modelId: 'gpt-5-mini' }],
  ['nothing saved', undefined],
])('keeps an On-Device transcript raw when cleanup is set to %s', async (_label, cleanup) => {
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' }, ...(cleanup ? { cleanup } : {}) },
  };

  const result = await transcribeOnDevice();

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe('um hello there');
  expect(result.cleanupApplied).toBe(false);
  expect(result.transcription.cleanupWarning).toBeUndefined();
});

it('keeps an On-Device transcript raw when cleanup is turned off', async () => {
  mockConfig = { ...mockConfig, cleanupEnabled: false };

  const result = await transcribeOnDevice();

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe('um hello there');
});

it.each([
  [
    'appleIntelligenceOff',
    "Apple Intelligence is turned off in iOS Settings, so this can't run on-device.",
  ],
  ['disabled', 'Local Apple Intelligence is turned off in AI Models.'],
  ['modelNotReady', 'Apple Intelligence is still preparing its local model. Try again later.'],
  ['unavailable', 'Local Apple Intelligence is unavailable on this device.'],
])('says why On-Device cleanup could not run when readiness is %s', async (status, reason) => {
  mockReadiness.mockResolvedValue({ status, tokenCounting: false });

  const result = await transcribeOnDevice();

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe('um hello there');
  expect(result.transcription.cleanupWarning).toBe(`${reason} Your raw transcript is saved.`);
});

it('checks readiness again before refusing, so a fix in iOS Settings takes effect', async () => {
  mockReadiness
    .mockResolvedValueOnce({ status: 'appleIntelligenceOff', tokenCounting: false })
    .mockResolvedValue({ status: 'ready', tokenCounting: true });

  const result = await transcribeOnDevice();

  expect(mockReadiness).toHaveBeenCalledWith({ refresh: true });
  expect(result.text).toBe('cleaned:um hello there');
});

it('keeps a transcript too long for the on-device reply raw rather than cut short', async () => {
  const longText = 'word '.repeat(700).trim();
  mockTranscribe.mockResolvedValue({ text: longText, provider: 'local', duration: 1 });

  const result = await transcribeOnDevice();

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe(longText);
  expect(result.transcription.cleanupWarning).toBe(
    'This transcript is too long for On-Device cleanup. Your raw transcript is saved.',
  );
});

it("uses Apple Intelligence's own token count for the length check when it has one", async () => {
  mockCountTokens.mockResolvedValue(5_000);

  const result = await transcribeOnDevice();

  expect(mockCountTokens).toHaveBeenCalledWith({ prompt: 'um hello there' });
  expect(mockReason).not.toHaveBeenCalled();
  expect(result.transcription.cleanupWarning).toMatch(/too long for On-Device cleanup/);
});

it('skips On-Device cleanup when the dictation was cancelled while transcribing', async () => {
  const result = await transcribeOnDevice({ shouldCancel: () => true });

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe('um hello there');
});

it('sends a custom cleanup prompt to On-Device cleanup', async () => {
  mockCustomPrompt = 'Always use bullet points.';

  await transcribeOnDevice();

  expect(mockReason).toHaveBeenCalledTimes(1);
  const req = mockReason.mock.calls[0][0] as Record<string, unknown>;
  expect(req.customPrompt).toBe('Always use bullet points.');
  expect(req.inferenceRoute).toEqual({ mode: 'local', scope: 'cleanup' });
});
