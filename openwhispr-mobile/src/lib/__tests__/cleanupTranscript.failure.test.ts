import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { cleanupTranscript } from '@/lib/cleanupTranscript';

// accountAccess pulls in the router for its sign-in alert; stub it here.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/lib/retry', () => ({
  withRetry: (operation: () => Promise<unknown>): Promise<unknown> => operation(),
  createApiRetryStrategy: (): Record<string, never> => ({}),
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
let mockConfig: Record<string, unknown> = { cleanupEnabled: true, defaultMode: 'cloud' };
let mockActiveMode = 'cloud';
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));

const mockProcessText = ReasoningService.processText as jest.Mock;
const providerCleanupRoute = {
  mode: 'providers',
  scope: 'cleanup',
  providerId: 'openai',
  modelId: 'gpt-4.1-mini',
  endpoint: 'https://api.openai.com/v1',
  credentialRef: 'provider.openai',
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { cleanupEnabled: true, defaultMode: 'cloud' };
  mockActiveMode = 'cloud';
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('cleanupTranscript keeps the raw transcript', () => {
  it('when the cleanup request fails', async () => {
    mockProcessText.mockRejectedValue(new Error('provider down'));
    const onSkipped = jest.fn();
    await expect(
      cleanupTranscript('um hello there', { inferenceRoute: providerCleanupRoute, onSkipped }),
    ).resolves.toBe('um hello there');
    expect(onSkipped).toHaveBeenCalledWith('Cleanup failed. Your raw transcript is saved.');
  });

  it.each(['', '   \n'])('when the model returns no text (%j)', async (cleaned) => {
    mockProcessText.mockResolvedValue({ text: cleaned, model: 'm' });
    const onSkipped = jest.fn();
    await expect(
      cleanupTranscript('um hello there', { inferenceRoute: providerCleanupRoute, onSkipped }),
    ).resolves.toBe('um hello there');
    expect(onSkipped).toHaveBeenCalledWith(
      'Cleanup returned no text. Your raw transcript is saved.',
    );
  });

  it('when a saved provider route no longer resolves, without falling back to Cloud', async () => {
    mockConfig = {
      cleanupEnabled: true,
      defaultMode: 'providers',
      inference: { cleanup: { mode: 'providers', providerId: 'openai' } },
    };
    const onSkipped = jest.fn();
    await expect(cleanupTranscript('um hello there', { onSkipped })).resolves.toBe(
      'um hello there',
    );
    expect(mockProcessText).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith(
      'The cleanup route is unavailable. Your raw transcript is saved.',
    );
  });

  it('when Bring Your Own Key mode has no cleanup choice, without using Cloud', async () => {
    mockActiveMode = 'providers';
    mockConfig = { cleanupEnabled: true, defaultMode: 'providers', inference: {} };
    const onSkipped = jest.fn();
    await expect(cleanupTranscript('um hello there', { onSkipped })).resolves.toBe(
      'um hello there',
    );
    expect(mockProcessText).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith(
      'Choose a cleanup provider in AI Models. Your raw transcript is saved.',
    );
  });
});

it('still uses OpenWhispr Cloud by default for a user who never chose a provider', async () => {
  mockProcessText.mockResolvedValue({ text: 'Hello there.', model: 'm' });
  await expect(cleanupTranscript('um hello there')).resolves.toBe('Hello there.');
  expect(mockProcessText).toHaveBeenCalledWith(
    expect.objectContaining({ inferenceRoute: { mode: 'openwhispr', scope: 'cleanup' } }),
  );
});
