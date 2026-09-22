import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { cleanupTranscript } from '@/lib/cleanupTranscript';

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
type MockAuthState = { user: { id: string; isAnonymous: boolean } | null };
let mockAuthState: MockAuthState = { user: { id: 'real', isAnonymous: false } };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => mockAuthState },
}));

const mockProcessText = ReasoningService.processText as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// The serial cleanup pass goes through /api/reason, which refuses an anonymous
// onboarding session. Skip the doomed round trip and return the transcript as
// is, exactly what the failure path would have done after a 403.
describe('cleanupTranscript for an anonymous session', () => {
  it('returns the raw transcript without calling the reasoning endpoint', async () => {
    mockAuthState = { user: { id: 'anon', isAnonymous: true } };

    await expect(cleanupTranscript('um hello there')).resolves.toBe('um hello there');
    expect(mockProcessText).not.toHaveBeenCalled();
  });

  it('still cleans for a real account', async () => {
    mockAuthState = { user: { id: 'real', isAnonymous: false } };

    await expect(cleanupTranscript('um hello there')).resolves.toBe('cleaned:um hello there');
  });
});
