/**
 * A transcript made on this phone is cleaned by Apple Intelligence in Local Mode, or wherever
 * the user chose On-Device cleanup, or by the provider they saved for cleanup with their own
 * key. Outside Local Mode, Cloud or no choice would send it off the device unasked, so the raw
 * transcript is kept.
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
let mockUser: { id: string; isAnonymous: boolean } | null = { id: 'u', isAnonymous: false };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
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
  mockUser = { id: 'u', isAnonymous: false };
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

const OPENAI_CLEANUP = {
  mode: 'providers',
  providerId: 'openai',
  modelId: 'gpt-5-mini',
  credentialRef: 'provider.openai',
};

it('sends an On-Device upload outside Local Mode to the provider saved for cleanup', async () => {
  mockActiveMode = 'cloud';
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'cloud',
    inference: { upload: { mode: 'local' }, cleanup: OPENAI_CLEANUP },
  };

  const result = await transcribeAndCleanup({
    audioUri: 'file://a.wav',
    provider: 'local',
    requestContext: 'file',
  });

  expect(mockReason).toHaveBeenCalledTimes(1);
  const req = mockReason.mock.calls[0][0] as Record<string, unknown>;
  expect(req.inferenceRoute).toMatchObject({
    mode: 'providers',
    scope: 'cleanup',
    providerId: 'openai',
    modelId: 'gpt-5-mini',
  });
  expect(req.routing).toEqual({ sendToChosenProvider: true });
  expect(mockReadiness).not.toHaveBeenCalled();
  expect(result.text).toBe('cleaned:um hello there');
  expect(result.cleanupApplied).toBe(true);
});

// Local Mode keeps dictation on this phone; cleanup runs what is saved for it.
it.each([
  ['OpenWhispr Cloud', { mode: 'openwhispr' }, { mode: 'openwhispr', scope: 'cleanup' }],
  ['a provider', OPENAI_CLEANUP, { mode: 'providers', scope: 'cleanup', providerId: 'openai' }],
  ['nothing, signed in', undefined, { mode: 'openwhispr', scope: 'cleanup' }],
])('cleans a Local Mode dictation with %s saved for cleanup', async (_label, cleanup, route) => {
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' }, ...(cleanup ? { cleanup } : {}) },
  };

  const result = await transcribeOnDevice();

  expect(mockReason).toHaveBeenCalledTimes(1);
  expect((mockReason.mock.calls[0][0] as Record<string, unknown>).inferenceRoute).toMatchObject(
    route,
  );
  expect(result.text).toBe('cleaned:um hello there');
});

// A separate Cloud pass needs a signed-in account, so an anonymous session cleans on this phone.
it('cleans a Local Mode dictation on this phone with nothing saved and no account', async () => {
  mockUser = { id: 'a', isAnonymous: true };
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  };

  const result = await transcribeOnDevice();

  expect((mockReason.mock.calls[0][0] as Record<string, unknown>).inferenceRoute).toEqual({
    mode: 'local',
    scope: 'cleanup',
  });
  expect(result.text).toBe('cleaned:um hello there');
});

it('keeps an On-Device upload raw outside Local Mode with nothing saved for cleanup', async () => {
  mockActiveMode = 'cloud';
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'cloud',
    inference: { upload: { mode: 'local' } },
  };

  const result = await transcribeAndCleanup({
    audioUri: 'file://a.wav',
    provider: 'local',
    requestContext: 'file',
  });

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe('um hello there');
  expect(result.cleanupApplied).toBe(false);
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
    "Apple Intelligence is turned off, so this can't run on-device. Turn it on in Settings → Apple Intelligence & Siri.",
  ],
  ['disabled', 'Local Apple Intelligence is turned off in AI Models.'],
  [
    'modelNotReady',
    'Apple Intelligence is still downloading its model. Check Settings → Apple Intelligence & Siri, and keep your iPhone on Wi-Fi and charging.',
  ],
  ['unavailable', 'Local Apple Intelligence is unavailable on this device.'],
])('says why On-Device cleanup could not run when readiness is %s', async (status, reason) => {
  mockReadiness.mockResolvedValue({ status, tokenCounting: false });

  const result = await transcribeOnDevice();

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe('um hello there');
  expect(result.transcription.cleanupWarning).toBe(`${reason} Your raw transcript is saved.`);
});

// Nobody chose On-Device cleanup here, and AI Models already says it is skipped.
describe('in Local Mode with nothing of its own saved for cleanup', () => {
  beforeEach(() => {
    mockUser = { id: 'a', isAnonymous: true };
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    };
  });

  it.each(['unsupportedDevice', 'unsupportedOS', 'disabled', 'appleIntelligenceOff'])(
    'skips cleanup quietly when readiness is %s',
    async (status) => {
      mockReadiness.mockResolvedValue({ status, tokenCounting: false });
      const onStage = jest.fn();

      const result = await transcribeOnDevice({ onStage });

      expect(mockReason).not.toHaveBeenCalled();
      expect(onStage).not.toHaveBeenCalledWith('cleaning', expect.anything());
      expect(result.text).toBe('um hello there');
      expect(result.transcription.cleanupWarning).toBeUndefined();
    },
  );

  // The launch upgrade holds cleanup On-Device for a config from before Local Mode's Cloud
  // defaults (localModeUpgradeConfig); the user still never chose it.
  it('skips quietly when Local Mode holds cleanup On-Device automatically', async () => {
    mockConfig = {
      ...mockConfig,
      inference: { dictation: { mode: 'local' }, cleanup: { mode: 'local' } },
      pinnedInference: ['cleanup'],
    };
    mockReadiness.mockResolvedValue({ status: 'unsupportedDevice', tokenCounting: false });

    const result = await transcribeOnDevice();

    expect(mockReason).not.toHaveBeenCalled();
    expect(result.transcription.cleanupWarning).toBeUndefined();
  });

  it('cleans once a fresh readiness check finds Apple Intelligence ready', async () => {
    mockReadiness
      .mockResolvedValueOnce({ status: 'appleIntelligenceOff', tokenCounting: false })
      .mockResolvedValue({ status: 'ready', tokenCounting: true });

    const result = await transcribeOnDevice();

    expect(mockReadiness).toHaveBeenCalledWith({ refresh: true });
    expect(result.text).toBe('cleaned:um hello there');
  });

  // A dictation change from Cloud holds cleanup there, which Local Mode can't run without an
  // account, so it cleans on this phone like an unsaved one (workflowSelection).
  describe('with Cloud held automatically', () => {
    beforeEach(() => {
      mockConfig = {
        ...mockConfig,
        inference: { dictation: { mode: 'local' }, cleanup: { mode: 'openwhispr' } },
        pinnedInference: ['cleanup'],
      };
    });

    it('cleans on this phone', async () => {
      mockReadiness.mockResolvedValue({ status: 'ready', tokenCounting: true });

      const result = await transcribeOnDevice();

      expect(result.text).toBe('cleaned:um hello there');
    });

    it('skips quietly when Apple Intelligence cannot run', async () => {
      mockReadiness.mockResolvedValue({ status: 'unsupportedDevice', tokenCounting: false });

      const result = await transcribeOnDevice();

      expect(mockReason).not.toHaveBeenCalled();
      expect(result.text).toBe('um hello there');
      expect(result.transcription.cleanupWarning).toBeUndefined();
    });
  });
});

// Cleaning a dictation made on this phone with Cloud is a separate pass that refuses anonymous
// sessions, so it is never attempted, and AI Models says why (workflowSummary).
it('keeps a Local Mode dictation raw, without a warning, for Cloud cleanup and no account', async () => {
  mockUser = { id: 'a', isAnonymous: true };
  mockConfig = {
    cleanupEnabled: true,
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' }, cleanup: { mode: 'openwhispr' } },
  };

  const result = await transcribeOnDevice();

  expect(mockReason).not.toHaveBeenCalled();
  expect(result.text).toBe('um hello there');
  expect(result.transcription.cleanupWarning).toBeUndefined();
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
