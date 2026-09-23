/**
 * Custom cleanup prompt wiring in cleanupTranscript:
 * - the stored override is passed as `customPrompt` for every cleanup context
 * - it is withheld when the dictation agent is applicable AND the transcript
 *   mentions the agent, so the server's default agent detection still routes
 *   the utterance to the action prompt (promptMode "cleanup" would disable it)
 * - existing short-circuits (cleanup off) stay ahead of it
 */
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import {
  cleanupTranscript,
  CLEANUP_TIMEOUT_MS,
  AGENT_ACTION_TIMEOUT_MS,
} from '@/lib/cleanupTranscript';

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

let mockConfig: Record<string, unknown> = { cleanupEnabled: true, defaultMode: 'cloud' };
let mockActiveMode = 'cloud';
let mockCustomPrompt: string | undefined = 'Always use bullet points, {{agentName}}.';

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => mockCustomPrompt,
}));

const mockProcessText = ReasoningService.processText as jest.Mock;
const lastRequest = (): Record<string, unknown> =>
  mockProcessText.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { cleanupEnabled: true, defaultMode: 'cloud', dictationAgentEnabled: true };
  mockActiveMode = 'cloud';
  mockCustomPrompt = 'Always use bullet points, {{agentName}}.';
});

describe('cleanupTranscript custom prompt — sent', () => {
  it('passes the override with the agent name for ordinary keyboard dictation', async () => {
    await cleanupTranscript('remind me to buy milk', { context: 'keyboard' });
    const req = lastRequest();
    expect(req.customPrompt).toBe('Always use bullet points, {{agentName}}.');
    expect(req.agentName).toBe('OpenWhispr');
    expect(req.timeoutMs).toBe(CLEANUP_TIMEOUT_MS);
  });

  it.each([undefined, 'recording', 'notes', 'meeting'] as const)(
    'applies to the %s context too, matching desktop',
    async (context) => {
      await cleanupTranscript('some text', context ? { context } : {});
      expect(lastRequest().customPrompt).toBe('Always use bullet points, {{agentName}}.');
    },
  );

  it('still sends it when the agent is disabled even if the name is spoken', async () => {
    mockConfig = { cleanupEnabled: true, defaultMode: 'cloud', dictationAgentEnabled: false };
    await cleanupTranscript('hey OpenWhispr rewrite this', { context: 'keyboard' });
    const req = lastRequest();
    expect(req.customPrompt).toBe('Always use bullet points, {{agentName}}.');
    expect(req.agentName).toBeUndefined();
  });

  it('still sends it in private mode, where the agent is never applicable', async () => {
    mockActiveMode = 'private';
    mockConfig = { cleanupEnabled: true, defaultMode: 'private', dictationAgentEnabled: true };
    await cleanupTranscript('hey OpenWhispr rewrite this', { context: 'keyboard' });
    const req = lastRequest();
    expect(req.customPrompt).toBe('Always use bullet points, {{agentName}}.');
    expect(req.agentName).toBeUndefined();
  });
});

describe('cleanupTranscript custom prompt — withheld for an agent mention', () => {
  it('omits the override so the server can route to the action prompt', async () => {
    await cleanupTranscript('hey OpenWhispr rewrite this as a haiku', { context: 'keyboard' });
    const req = lastRequest();
    expect(req.customPrompt).toBeUndefined();
    expect(req.agentName).toBe('OpenWhispr');
    expect(req.timeoutMs).toBe(AGENT_ACTION_TIMEOUT_MS);
  });
});

describe('cleanupTranscript custom prompt — regression guards', () => {
  it('sends no customPrompt when the user has no override', async () => {
    mockCustomPrompt = undefined;
    await cleanupTranscript('remind me to buy milk', { context: 'keyboard' });
    expect(lastRequest().customPrompt).toBeUndefined();
  });

  it('returns the raw text without a request when cleanup is disabled', async () => {
    mockConfig = { cleanupEnabled: false, defaultMode: 'cloud' };
    await expect(cleanupTranscript('um hello', { context: 'keyboard' })).resolves.toBe('um hello');
    expect(mockProcessText).not.toHaveBeenCalled();
  });
});
