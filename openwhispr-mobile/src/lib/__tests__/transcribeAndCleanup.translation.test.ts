import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { cleanupTranscript } from '@/lib/cleanupTranscript';
import { translateTranscript } from '@/lib/translateTranscript';
import type { TranscriptionRequest } from '@/types';

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

jest.mock('@/lib/translateTranscript', () => ({
  translateTranscript: jest.fn(async (text: string) => ({ text: `es:${text}`, translated: true })),
}));

jest.mock('@/lib/permissions', () => ({
  isNoSpeechError: jest.fn(() => false),
}));

let mockConfig: Record<string, unknown> = { cleanupEnabled: true };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

const mockUser = { id: 'u', isAnonymous: false };
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

jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({ text: req.text, model: 'm' })),
  },
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));

const PROVIDER_ROUTE = {
  mode: 'providers' as const,
  scope: 'cleanup' as const,
  providerId: 'groq',
  modelId: 'llama',
  endpoint: 'https://api.groq.com/openai/v1',
};

const mockTranscribeService = TranscriptionService.transcribe as jest.Mock;
const mockFused = TranscriptionService.transcribeWithCloudCleanup as jest.Mock;
const mockCleanupTranscript = cleanupTranscript as jest.Mock;
const mockTranslate = translateTranscript as jest.Mock;

function mockTranscribe(text: string): void {
  mockTranscribeService.mockResolvedValue({ text, provider: 'cloud', duration: 1 });
}

function mockCleanup(text: string): void {
  mockCleanupTranscript.mockResolvedValue(text);
}

function setCleanupEnabled(enabled: boolean): void {
  mockConfig = { cleanupEnabled: enabled };
}

// A provider cleanup route keeps these requests on the serial path.
const keyboardRequest: TranscriptionRequest = {
  audioUri: 'file://a.wav',
  provider: 'cloud',
  requestContext: 'keyboard',
  cleanupRoute: PROVIDER_ROUTE,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { cleanupEnabled: true };
  mockTranscribe('hello world');
  mockCleanupTranscript.mockImplementation(async (text: string) => `cleaned:${text}`);
  mockTranslate.mockImplementation(async (text: string) => ({
    text: `es:${text}`,
    translated: true,
  }));
});

describe('transcribeAndCleanup translation', () => {
  it('translates after cleanup and keeps the raw transcript as originalText', async () => {
    mockTranscribe('hello there');
    mockCleanup('Hello there.');
    mockTranslate.mockResolvedValue({ text: 'Hola.', translated: true });

    const out = await transcribeAndCleanup({ ...keyboardRequest, translationTarget: 'es' });

    expect(mockTranslate).toHaveBeenCalledWith(
      'Hello there.',
      expect.objectContaining({ target: 'es', inferenceRoute: PROVIDER_ROUTE }),
    );
    expect(out).toMatchObject({ text: 'Hola.', originalText: 'hello there', translatedTo: 'es' });
    expect(out.transcription).toMatchObject({
      text: 'Hola.',
      originalText: 'hello there',
      translatedTo: 'es',
    });
  });

  it('translates the raw transcript when cleanup is off', async () => {
    setCleanupEnabled(false);
    mockTranscribe('hello there');
    mockCleanupTranscript.mockImplementation(async (text: string) => text);
    mockTranslate.mockResolvedValue({ text: 'Hola.', translated: true });

    const out = await transcribeAndCleanup({ ...keyboardRequest, translationTarget: 'es' });

    expect(mockTranslate).toHaveBeenCalledWith('hello there', expect.anything());
    expect(out.text).toBe('Hola.');
    expect(out.originalText).toBe('hello there');
  });

  it('translates the fused cleanup result', async () => {
    mockFused.mockResolvedValue({
      text: 'Hello there.',
      originalText: 'hello there',
      provider: 'cloud',
      duration: 1,
      cleanupApplied: true,
      fusedCleanup: true,
    });
    mockTranslate.mockResolvedValue({ text: 'Hola.', translated: true });

    const out = await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
      translationTarget: 'es',
    });

    expect(mockFused).toHaveBeenCalled();
    expect(mockTranslate).toHaveBeenCalledWith(
      'Hello there.',
      expect.objectContaining({
        target: 'es',
        inferenceRoute: expect.objectContaining({ mode: 'openwhispr' }),
      }),
    );
    expect(out).toMatchObject({ text: 'Hola.', originalText: 'hello there', translatedTo: 'es' });
  });

  it('passes the pinned cleanupUnavailable through', async () => {
    await transcribeAndCleanup({
      audioUri: 'file://a.wav',
      provider: 'byok',
      inferenceRoute: { ...PROVIDER_ROUTE, scope: 'dictation' as never },
      requestContext: 'keyboard',
      cleanupUnavailable: 'Choose a cleanup provider.',
      translationTarget: 'es',
    });

    expect(mockTranslate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cleanupUnavailable: 'Choose a cleanup provider.' }),
    );
  });

  it('leaves translatedTo unset and surfaces the reason when translation is skipped', async () => {
    mockTranslate.mockImplementation(
      async (text: string, options: { onSkipped?: (reason: string) => void }) => {
        options.onSkipped?.('reason');
        return { text, translated: false };
      },
    );

    const out = await transcribeAndCleanup({ ...keyboardRequest, translationTarget: 'es' });

    expect(out.text).toBe('cleaned:hello world');
    expect(out.translatedTo).toBeUndefined();
    expect(out.transcription.translatedTo).toBeUndefined();
    expect(out.transcription.cleanupWarning).toBe('reason');
  });

  it('keeps the cleanup warning when translation is also skipped', async () => {
    mockCleanupTranscript.mockImplementation(
      async (text: string, options: { onSkipped?: (reason: string) => void }) => {
        options.onSkipped?.('cleanup reason');
        return text;
      },
    );
    mockTranslate.mockImplementation(
      async (text: string, options: { onSkipped?: (reason: string) => void }) => {
        options.onSkipped?.('translate reason');
        return { text, translated: false };
      },
    );

    const out = await transcribeAndCleanup({ ...keyboardRequest, translationTarget: 'es' });

    expect(out.transcription.cleanupWarning).toBe('cleanup reason');
  });

  it('does not translate when the dictation language is the target', async () => {
    await transcribeAndCleanup({ ...keyboardRequest, language: 'es', translationTarget: 'es' });
    expect(mockTranslate).not.toHaveBeenCalled();
  });

  it('does not translate without a target', async () => {
    const out = await transcribeAndCleanup(keyboardRequest);
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(out.translatedTo).toBeUndefined();
  });

  it('does not translate after a cancel', async () => {
    await transcribeAndCleanup(
      { ...keyboardRequest, translationTarget: 'es' },
      { shouldCancel: () => true },
    );
    expect(mockTranslate).not.toHaveBeenCalled();
  });

  it('does not translate an empty transcript', async () => {
    mockTranscribe('');
    mockCleanupTranscript.mockImplementation(async (text: string) => text);
    await transcribeAndCleanup({ ...keyboardRequest, translationTarget: 'es' });
    expect(mockTranslate).not.toHaveBeenCalled();
  });

  it.each(['recording', 'file'] as const)(
    'does not translate a %s request',
    async (requestContext) => {
      await transcribeAndCleanup({ ...keyboardRequest, requestContext, translationTarget: 'es' });
      expect(mockTranslate).not.toHaveBeenCalled();
    },
  );

  it('reports the translating stage', async () => {
    const onStage = jest.fn();
    await transcribeAndCleanup({ ...keyboardRequest, translationTarget: 'es' }, { onStage });
    expect(onStage).toHaveBeenCalledWith('translating');
  });
});
