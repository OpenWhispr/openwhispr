import { streamAgentText } from '../AgentStreamClient';
import { processProviderText } from '@/services/providers/ProviderExecution';
import {
  getInferenceSelection,
  resolveMobileProviderRoute,
  type ProviderRoute,
} from '@/lib/inferenceRouting';
import { fetch } from 'expo/fetch';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/lib/apiClient', () => ({
  ApiError: class extends Error {},
  BASE_URL: 'https://api.example.test',
}));
jest.mock('@/lib/inferenceRouting', () => ({
  getInferenceSelection: jest.fn(),
  resolveMobileProviderRoute: jest.fn(),
}));
jest.mock('@/services/providers/ProviderExecution', () => ({ processProviderText: jest.fn() }));

const route: ProviderRoute = {
  mode: 'providers',
  scope: 'agent',
  providerId: 'openai',
  modelId: 'gpt-4o-mini',
  endpoint: 'https://api.openai.com/v1',
  credentialRef: 'provider.openai',
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getInferenceSelection).mockReturnValue(route);
  jest.mocked(resolveMobileProviderRoute).mockResolvedValue(route);
  jest.mocked(processProviderText).mockResolvedValue({ text: 'new draft', model: route.modelId });
});

it('preserves role-separated history and cancellation on direct provider composition', async () => {
  const controller = new AbortController();
  await expect(
    streamAgentText({
      messages: [
        { role: 'user', content: 'write a note' },
        { role: 'assistant', content: 'old draft' },
        { role: 'user', content: 'make it formal' },
      ],
      systemPrompt: 'Compose text.',
      signal: controller.signal,
    }),
  ).resolves.toBe('new draft');
  expect(processProviderText).toHaveBeenCalledWith(
    expect.objectContaining({
      route,
      text: 'make it formal',
      messages: [
        { role: 'user', content: 'write a note' },
        { role: 'assistant', content: 'old draft' },
      ],
      systemPrompt: 'Compose text.',
      signal: expect.anything(),
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the persisted provider route after provider settings change', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'openwhispr' });
  await streamAgentText({ messages: [{ role: 'user', content: 'revise' }], inferenceRoute: route });
  expect(resolveMobileProviderRoute).toHaveBeenCalledWith('agent', route);
  expect(fetch).not.toHaveBeenCalled();
});

it('does not fall back to Cloud when policy or provider execution fails', async () => {
  jest.mocked(resolveMobileProviderRoute).mockRejectedValueOnce(new Error('policy denied'));
  await expect(streamAgentText({ messages: [{ role: 'user', content: 'write' }] })).rejects.toThrow(
    'policy denied',
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects unsupported local composition without a remote request', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'local' });
  await expect(streamAgentText({ messages: [{ role: 'user', content: 'write' }] })).rejects.toThrow(
    'On-device keyboard composition',
  );
  expect(processProviderText).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
