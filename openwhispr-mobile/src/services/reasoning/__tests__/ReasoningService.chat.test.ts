import type { ProviderRoute } from '@/lib/inferenceRouting';
import { ReasoningService } from '../ReasoningService';
import { api } from '@/lib/apiClient';
import { getInferenceSelection, resolveMobileProviderRoute } from '@/lib/inferenceRouting';
import { processProviderText } from '@/services/providers/ProviderExecution';

jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('@/lib/inferenceRouting', () => ({
  getInferenceSelection: jest.fn(),
  resolveMobileProviderRoute: jest.fn(),
}));
jest.mock('@/services/providers/ProviderExecution', () => ({ processProviderText: jest.fn() }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: jest.fn(() => ({ activeMode: 'cloud' })) },
}));
jest.mock('@/lib/localReasoning', () => ({
  isLocalReasoningRequired: (): boolean => false,
  getLocalReasoningReadiness: async (): Promise<{ status: string }> => ({ status: 'unavailable' }),
  getLocalReasoningUnavailableMessage: (): string => 'Local unavailable',
  LocalReasoningError: class extends Error {
    constructor(_code: string, message: string) {
      super(message);
    }
  },
}));

const route: ProviderRoute = {
  mode: 'providers',
  scope: 'noteChat',
  providerId: 'openai',
  modelId: 'gpt-4o-mini',
  endpoint: 'https://api.openai.com/v1',
  credentialRef: 'provider.openai',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.post).mockResolvedValue({ text: 'cloud answer', model: 'cloud' });
  jest.mocked(resolveMobileProviderRoute).mockResolvedValue(route);
  jest.mocked(processProviderText).mockResolvedValue({ text: 'provider answer', model: 'm' });
});

describe('ReasoningService.chat', () => {
  it('routes chat through Cloud when Note Chat is on OpenWhispr', async () => {
    jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'openwhispr' });
    await expect(
      ReasoningService.chat({ systemPrompt: 'You are a helper.', text: 'hello' }),
    ).resolves.toMatchObject({ text: 'cloud answer' });
    expect(getInferenceSelection).toHaveBeenCalledWith('noteChat');
    expect(api.post).toHaveBeenCalledWith(
      '/api/reason',
      expect.objectContaining({ systemPrompt: 'You are a helper.' }),
      expect.anything(),
    );
    expect(processProviderText).not.toHaveBeenCalled();
  });

  it('never answers a chat with its own prompt when Cloud returns no text', async () => {
    jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'openwhispr' });
    jest.mocked(api.post).mockResolvedValue({ text: '', model: 'cloud' });

    await expect(
      ReasoningService.chat({ systemPrompt: 's', text: 'NOTES: private plans' }),
    ).resolves.toMatchObject({ text: '' });
  });

  it('routes chat through processText for providers and local', async () => {
    jest.mocked(getInferenceSelection).mockReturnValue(route);
    await expect(
      ReasoningService.chat({ systemPrompt: 'You are a helper.', text: 'hello' }),
    ).resolves.toMatchObject({ text: 'provider answer' });
    expect(resolveMobileProviderRoute).toHaveBeenCalledWith('noteChat', route, false, false);
    expect(processProviderText).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'You are a helper.', text: 'hello' }),
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('prefers a snapshotted inferenceRoute over the current selection', async () => {
    jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'openwhispr' });
    await ReasoningService.chat({ systemPrompt: 's', text: 't', inferenceRoute: route });
    expect(resolveMobileProviderRoute).toHaveBeenCalledWith('noteChat', route, false, false);
    expect(api.post).not.toHaveBeenCalled();
  });
});
