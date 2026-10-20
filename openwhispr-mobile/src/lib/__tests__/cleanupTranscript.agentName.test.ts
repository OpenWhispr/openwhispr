/**
 * Saying the assistant's name while dictating gives no command: the voice assistant is the
 * keyboard's compose wand. Dictation cleanup is told the name only so its prompt keeps it as
 * dictated words, and an addressed dictation is cleaned like any other.
 */
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { cleanupTranscript, CLEANUP_TIMEOUT_MS } from '@/lib/cleanupTranscript';

// accountAccess pulls in the router for its sign-in alert; stub it here.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({
      text: `cleaned:${req.text}`,
      model: 'm',
    })),
  },
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

// Config store: use a mutable ref so each test can set a different config without
// jest.resetModules (which doesn't work without --experimental-vm-modules).
let mockConfig: Record<string, unknown> = { cleanupEnabled: true, defaultMode: 'cloud' };
let mockActiveMode = 'cloud';

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));

const mockProcessText = ReasoningService.processText as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { cleanupEnabled: true, defaultMode: 'cloud' };
  mockActiveMode = 'cloud';
});

describe('cleanupTranscript agentName', () => {
  it.each(['keyboard', 'recording'] as const)('tells %s cleanup the name', async (context) => {
    mockConfig = { cleanupEnabled: true, defaultMode: 'cloud', dictationAgentName: 'Aria' };

    await cleanupTranscript('hello there', { context });

    expect((mockProcessText.mock.calls[0][0] as Record<string, unknown>).agentName).toBe('Aria');
  });

  it('uses the default name when none is set', async () => {
    await cleanupTranscript('hello there', { context: 'keyboard' });

    expect((mockProcessText.mock.calls[0][0] as Record<string, unknown>).agentName).toBe(
      'OpenWhispr',
    );
  });

  it.each([['notes'], ['meeting'], [undefined]] as const)(
    'does not tell %s cleanup the name',
    async (context) => {
      await cleanupTranscript('hello there', { context });

      expect(
        (mockProcessText.mock.calls[0][0] as Record<string, unknown>).agentName,
      ).toBeUndefined();
    },
  );
});

describe('a dictation that addresses the assistant by name', () => {
  it.each([
    ['in Cloud mode', 'cloud', {}],
    // On-Device cleanup of an addressed dictation is covered in cleanupTranscript.onDevice.test.ts.
    ['in Local Mode on a Cloud fallback', 'private', {}],
    ['with the voice assistant switched off', 'cloud', { dictationAgentEnabled: false }],
  ])('is cleaned, not run as a command, %s', async (_label, mode, settings) => {
    mockActiveMode = mode;
    mockConfig = { cleanupEnabled: true, defaultMode: mode, ...settings };

    await cleanupTranscript('hey OpenWhispr write an email to Sam', {
      context: 'keyboard',
      cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
    });

    expect(mockProcessText).toHaveBeenCalledTimes(1);
    const req = mockProcessText.mock.calls[0][0] as Record<string, unknown>;
    expect(req.inferenceScope).toBe('cleanup');
    expect(req.inferenceRoute).toEqual({ mode: 'openwhispr', scope: 'cleanup' });
    expect(req.timeoutMs).toBe(CLEANUP_TIMEOUT_MS);
    expect(req.agentName).toBe('OpenWhispr');
  });
});
