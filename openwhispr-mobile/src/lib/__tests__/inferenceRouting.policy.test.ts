import type { InferencePolicy, InferenceSelection } from '@/lib/mobileProviders';

const mockGetPolicy = jest.fn<Promise<InferencePolicy>, []>();
jest.mock('@/services/providers/ProviderPolicy', () => ({
  getProviderPolicy: (): Promise<InferencePolicy> => mockGetPolicy(),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { inference: {} } }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
import { resolveMobileProviderRoute } from '../inferenceRouting';

const openaiSpeech: InferenceSelection = {
  mode: 'providers',
  providerId: 'openai',
  modelId: 'whisper-1',
  credentialRef: 'provider.openai',
};
const openaiText: InferenceSelection = { ...openaiSpeech, modelId: 'gpt-4.1-mini' };
const blocked = 'Your organization does not allow this provider or mode.';

// The runtime policy, not the saved selection, decides what may leave the device.
function managed(
  allowedByokProviders: string[],
  agentEnabled = true,
): Extract<InferencePolicy, { status: 'managed' }> {
  const scope = { allowedModes: ['providers'], allowedByokProviders };
  return { status: 'managed', transcription: scope, llm: scope, agentEnabled };
}

beforeEach(() => {
  mockGetPolicy.mockReset();
});

it.each([
  ['dictation', openaiSpeech],
  ['upload', openaiSpeech],
  ['cleanup', openaiText],
  ['notes', openaiText],
  ['agent', openaiText],
] as const)('refuses a provider the managed allowlist omits for %s', async (scope, selection) => {
  mockGetPolicy.mockResolvedValue(managed(['groq']));
  await expect(resolveMobileProviderRoute(scope, selection)).rejects.toMatchObject({
    message: blocked,
    retryable: false,
  });
  mockGetPolicy.mockResolvedValue(managed(['openai']));
  await expect(resolveMobileProviderRoute(scope, selection)).resolves.toMatchObject({
    providerId: 'openai',
  });
});

it('applies the speech and text allowlists to their own scopes', async () => {
  mockGetPolicy.mockResolvedValue({
    status: 'managed',
    transcription: { allowedModes: ['providers'], allowedByokProviders: ['groq'] },
    llm: { allowedModes: ['providers'], allowedByokProviders: ['openai'] },
  });
  await expect(resolveMobileProviderRoute('dictation', openaiSpeech)).rejects.toMatchObject({
    message: blocked,
  });
  await expect(resolveMobileProviderRoute('cleanup', openaiText)).resolves.toMatchObject({
    providerId: 'openai',
  });
});

it('refuses the agent scope when the organization disables the agent', async () => {
  mockGetPolicy.mockResolvedValue(managed(['openai'], false));
  await expect(resolveMobileProviderRoute('agent', openaiText)).rejects.toMatchObject({
    message: blocked,
  });
  await expect(resolveMobileProviderRoute('cleanup', openaiText)).resolves.toMatchObject({
    providerId: 'openai',
  });
});

it('refuses every provider while the policy is unresolved', async () => {
  mockGetPolicy.mockResolvedValue({ status: 'pending' });
  await expect(resolveMobileProviderRoute('cleanup', openaiText)).rejects.toMatchObject({
    message: 'Organization policy is unavailable. Try again when connected.',
  });
});
