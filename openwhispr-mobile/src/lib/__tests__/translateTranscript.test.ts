import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { buildTranslatePrompt } from '@/lib/keyboardTranslation';
import { translateTranscript } from '@/lib/translateTranscript';

// accountAccess pulls in the router for its sign-in alert; stub it here.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
// cleanupTranscript (which owns the shared timeout) imports these stores at load.
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { cleanupEnabled: true, defaultMode: 'cloud' } }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
const mockCountTokens = jest.fn();
jest.mock('@/lib/localReasoning', () => ({
  ...jest.requireActual('@/lib/localReasoning'),
  countLocalReasoningTokens: () => mockCountTokens(),
}));
let mockGuestSession = false;
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: mockGuestSession
        ? { id: 'anon', isAnonymous: true }
        : { id: 'real', isAnonymous: false },
    }),
  },
}));

const processText = ReasoningService.processText as jest.Mock;
const SKIPPED = "Couldn't translate to Spanish. Your text was typed untranslated.";

beforeEach(() => {
  jest.clearAllMocks();
  mockGuestSession = false;
});

describe('translateTranscript', () => {
  it('returns the translation and sends purpose "translation" with the prompt', async () => {
    processText.mockResolvedValue({ text: 'Hola', model: 'm' });
    const out = await translateTranscript('Hello', { target: 'es' });
    expect(out).toEqual({ text: 'Hola', translated: true });
    expect(processText).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'translation',
        systemPrompt: buildTranslatePrompt('es'),
        text: 'Hello',
        inferenceScope: 'cleanup',
        timeoutMs: 12_000,
      }),
    );
  });

  it.each(['', '   '])('keeps the input and warns when the reply is %p', async (reply) => {
    processText.mockResolvedValue({ text: reply, model: 'm' });
    const onSkipped = jest.fn();
    expect(await translateTranscript('Hello', { target: 'es', onSkipped })).toEqual({
      text: 'Hello',
      translated: false,
    });
    expect(onSkipped).toHaveBeenCalledWith(SKIPPED);
    // An empty reply is an answer, not a failure to retry.
    expect(processText).toHaveBeenCalledTimes(1);
  });

  it.each(['Hello', ' Hello  ', 'Hello\n'])(
    'keeps the input without a warning when the reply is unchanged (%p)',
    async (reply) => {
      processText.mockResolvedValue({ text: reply, model: 'm' });
      const onSkipped = jest.fn();
      expect(await translateTranscript('Hello', { target: 'es', onSkipped })).toEqual({
        text: 'Hello',
        translated: false,
      });
      // Already in the target language: desktop treats it as done, not as a failure.
      expect(onSkipped).not.toHaveBeenCalled();
      expect(processText).toHaveBeenCalledTimes(1);
    },
  );

  it('gives an On-Device translation the on-device budget for its length', async () => {
    mockCountTokens.mockResolvedValue(500);
    processText.mockResolvedValue({ text: 'Hola', model: 'm' });
    await translateTranscript('Hello', {
      target: 'es',
      inferenceRoute: { mode: 'local', scope: 'cleanup' },
    });
    // 5 s to start plus 500 tokens at 25 a second, as On-Device cleanup.
    expect(processText).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 25_000 }));
  });

  it('keeps 12 s On-Device for a short dictation', async () => {
    mockCountTokens.mockResolvedValue(20);
    processText.mockResolvedValue({ text: 'Hola', model: 'm' });
    await translateTranscript('Hello', {
      target: 'es',
      inferenceRoute: { mode: 'local', scope: 'cleanup' },
    });
    expect(processText).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 12_000 }));
  });

  it('compares with collapsed whitespace', async () => {
    processText.mockResolvedValue({ text: 'Hello   big\nworld', model: 'm' });
    const out = await translateTranscript('Hello big world', { target: 'es' });
    expect(out).toEqual({ text: 'Hello big world', translated: false });
  });

  it('keeps the input when the model throws', async () => {
    processText.mockRejectedValue(Object.assign(new Error('boom'), { status: 400 }));
    const onSkipped = jest.fn();
    expect(await translateTranscript('Hello', { target: 'es', onSkipped })).toEqual({
      text: 'Hello',
      translated: false,
    });
    expect(onSkipped).toHaveBeenCalledWith(SKIPPED);
  });

  it('retries once after a server error', async () => {
    processText
      .mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }))
      .mockResolvedValueOnce({ text: 'Hola', model: 'm' });
    expect(await translateTranscript('Hello', { target: 'es' })).toEqual({
      text: 'Hola',
      translated: true,
    });
    expect(processText).toHaveBeenCalledTimes(2);
  });

  it('does not retry a request the timeout or a cancel aborted', async () => {
    processText.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await translateTranscript('Hello', { target: 'es' })).toEqual({
      text: 'Hello',
      translated: false,
    });
    expect(processText).toHaveBeenCalledTimes(1);
  });

  it('does not call the model for a guest on Cloud', async () => {
    mockGuestSession = true;
    const onSkipped = jest.fn();
    const out = await translateTranscript('Hello', {
      target: 'es',
      inferenceRoute: { mode: 'openwhispr', scope: 'cleanup' },
      onSkipped,
    });
    expect(out).toEqual({ text: 'Hello', translated: false });
    expect(processText).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith(
      'Sign in to translate dictation. Your text was typed untranslated.',
    );
  });

  it('does not call the model when cleanup is unavailable', async () => {
    const onSkipped = jest.fn();
    const out = await translateTranscript('Hello', {
      target: 'es',
      cleanupUnavailable: 'Cleanup is unavailable.',
      onSkipped,
    });
    expect(out).toEqual({ text: 'Hello', translated: false });
    expect(processText).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith('Cleanup is unavailable.');
  });

  it('does not call the model for empty text', async () => {
    expect(await translateTranscript('  ', { target: 'es' })).toEqual({
      text: '  ',
      translated: false,
    });
    expect(processText).not.toHaveBeenCalled();
  });
});
