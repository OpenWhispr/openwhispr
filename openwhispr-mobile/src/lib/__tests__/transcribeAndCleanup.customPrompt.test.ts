/**
 * A custom cleanup prompt is injected via /api/reason, which only the serial
 * cleanup pass calls; the fused /api/transcribe cleanup accepts flags only. So
 * an active override must force the serial path, like a non-default tone does.
 */
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { isRetryableTranscriptionError, transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { cleanupTranscript } from '@/lib/cleanupTranscript';
import { transcriptionPolicyErrorFromResponse } from '@/services/transcription/policyErrors';

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

  it('never cleans a local transcript when cleanup is not On-Device, override or not', async () => {
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

describe('transcription retry classification', () => {
  it.each([
    ['invalid credential', { status: 401, retryable: false }],
    ['invalid model', { status: 404, retryable: false }],
    ['blocked redirect', { retryable: false }],
    ['cancelled request', Object.assign(new Error('cancelled'), { name: 'AbortError' })],
  ])('does not retry %s provider failures', (_label, error) => {
    expect(isRetryableTranscriptionError(error)).toBe(false);
  });

  it.each([
    ['provider unavailable', { status: 503, retryable: true }],
    ['network failure', { retryable: true }],
  ])('retries %s failures', (_label, error) => {
    expect(isRetryableTranscriptionError(error)).toBe(true);
  });
});

describe('org policy and version refusals', () => {
  const refusals = [
    ['POLICY_AUDIO_UPLOAD_DISABLED', 403, { code: 'POLICY_AUDIO_UPLOAD_DISABLED' }],
    ['POLICY_MEETING_RECORDING_DISABLED', 403, { code: 'POLICY_MEETING_RECORDING_DISABLED' }],
    ['POLICY_MODE_BLOCKED', 403, { code: 'POLICY_MODE_BLOCKED' }],
    ['an upgrade-required response', 426, {}],
  ] as const;
  const refusal = (status: number, body: object): Error => {
    const error = transcriptionPolicyErrorFromResponse(status, JSON.stringify(body));
    if (!error) throw new Error(`HTTP ${status} was not mapped to a policy error`);
    return error;
  };

  it.each(refusals)('never retries %s', (_label, status, body) => {
    expect(isRetryableTranscriptionError(refusal(status, body))).toBe(false);
  });

  it.each(refusals)('sends %s once on the fused path', async (_label, status, body) => {
    mockCustomPrompt = undefined;
    const error = refusal(status, body);
    mockFused.mockRejectedValue(error);
    await expect(
      transcribeAndCleanup({ audioUri: 'file://a.wav', provider: 'cloud', requestContext: 'file' }),
    ).rejects.toBe(error);
    expect(mockFused).toHaveBeenCalledTimes(1);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it.each(refusals)('sends %s once on the serial path', async (_label, status, body) => {
    const error = refusal(status, body);
    mockTranscribe.mockRejectedValue(error);
    await expect(
      transcribeAndCleanup({
        audioUri: 'file://a.wav',
        provider: 'cloud',
        requestContext: 'recording',
      }),
    ).rejects.toBe(error);
    expect(mockFused).not.toHaveBeenCalled();
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });
});
