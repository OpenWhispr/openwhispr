import type { ProviderRoute } from '@/lib/inferenceRouting';
import { ReasoningService } from '../ReasoningService';
import { api } from '@/lib/apiClient';
import { getInferenceSelection, resolveMobileProviderRoute } from '@/lib/inferenceRouting';
import { processProviderText } from '@/services/providers/ProviderExecution';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('@/lib/inferenceRouting', () => ({
  getInferenceSelection: jest.fn(),
  resolveMobileProviderRoute: jest.fn(),
}));
jest.mock('@/services/providers/ProviderExecution', () => ({ processProviderText: jest.fn() }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: jest.fn() },
}));
jest.mock('@/lib/localReasoning', () => ({
  isLocalReasoningRequired: (): boolean => true,
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
  scope: 'cleanup',
  providerId: 'openai',
  modelId: 'gpt-4o-mini',
  endpoint: 'https://api.openai.com/v1',
  credentialRef: 'provider.openai',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getInferenceSelection).mockReturnValue(route);
  jest.mocked(resolveMobileProviderRoute).mockResolvedValue(route);
  jest
    .mocked(useProcessingModeStore.getState)
    .mockReturnValue({ activeMode: 'cloud' } as ReturnType<typeof useProcessingModeStore.getState>);
  jest
    .mocked(processProviderText)
    .mockResolvedValue({ text: 'Clean result.', model: 'gpt-4o-mini' });
});

it('uses configured BYOK for signed-out public text without a cloud request', async () => {
  await expect(ReasoningService.processText({ text: 'um result', routing: {} })).resolves.toEqual({
    text: 'Clean result.',
    model: 'gpt-4o-mini',
  });
  expect(processProviderText).toHaveBeenCalledWith(
    expect.objectContaining({
      route,
      text: '<transcript>\num result\n</transcript>\n\nOutput only the cleaned transcript.',
    }),
  );
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps a snapshotted route when current provider settings change', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'openwhispr' });
  await ReasoningService.processText({
    text: 'input',
    inferenceScope: 'notes',
    inferenceRoute: { ...route, scope: 'notes' },
    systemPrompt: 'Summarize.',
  });
  expect(resolveMobileProviderRoute).toHaveBeenCalledWith(
    'notes',
    expect.objectContaining({ providerId: 'openai', scope: 'notes' }),
    false,
    false,
  );
});

it('does not send protected content to BYOK without explicit permission', async () => {
  await expect(
    ReasoningService.processText({
      text: 'private',
      systemPrompt: 'Summarize.',
      routing: { isPrivateNote: true },
    }),
  ).rejects.toThrow('Local unavailable');
  expect(processProviderText).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

it('honors private mode even for hint-less BYOK cleanup', async () => {
  jest
    .mocked(useProcessingModeStore.getState)
    .mockReturnValue({ activeMode: 'private' } as ReturnType<
      typeof useProcessingModeStore.getState
    >);
  await expect(ReasoningService.processText({ text: 'private' })).rejects.toThrow();
  expect(processProviderText).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

it('passes explicit one-request remote permission to the provider route resolver', async () => {
  await ReasoningService.processText({
    text: 'private',
    systemPrompt: 'Summarize.',
    routing: { isPrivateNote: true, allowCloudFallback: true },
  });
  expect(resolveMobileProviderRoute).toHaveBeenCalledWith('cleanup', route, true, true);
  expect(processProviderText).toHaveBeenCalledTimes(1);
  expect(api.post).not.toHaveBeenCalled();
});

it('never falls back to OpenWhispr when provider setup or execution fails', async () => {
  jest.mocked(resolveMobileProviderRoute).mockRejectedValueOnce(new Error('missing key'));
  await expect(ReasoningService.processText({ text: 'input' })).rejects.toThrow('missing key');
  jest.mocked(processProviderText).mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(ReasoningService.processText({ text: 'input' })).rejects.toThrow(
    'provider unavailable',
  );
  expect(api.post).not.toHaveBeenCalled();
});

it('routes note chat through the agent scope and retains its bounded chat prompt', async () => {
  await ReasoningService.chatOverNote({ context: 'note context', question: 'why?', history: [] });
  expect(resolveMobileProviderRoute).toHaveBeenCalledWith('agent', route, false, false);
  expect(processProviderText).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining('NOTE OR TRANSCRIPT CONTEXT:\nnote context'),
      systemPrompt: expect.stringContaining('note Q&A assistant'),
    }),
  );
  expect(api.post).not.toHaveBeenCalled();
});

it('never sends an On-Device text scope to OpenWhispr Cloud, even with fallback consent', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'local' });
  await expect(
    ReasoningService.processText({
      text: 'private note question',
      systemPrompt: 'answer',
      inferenceScope: 'agent',
      routing: { isPrivateNote: true, allowCloudFallback: true },
    }),
  ).rejects.toThrow('On-device AI is unavailable for this request');
  expect(api.post).not.toHaveBeenCalled();
  expect(processProviderText).not.toHaveBeenCalled();
});

it('keeps note chat on OpenWhispr Cloud when no provider or On-Device selection exists', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue(undefined);
  jest.mocked(api.post).mockResolvedValue({ text: 'cloud answer', model: 'cloud' });
  await expect(
    ReasoningService.chatOverNote({
      context: 'note body',
      question: 'what?',
      history: [],
      routing: { isPrivateNote: true, allowCloudFallback: true },
    }),
  ).resolves.toMatchObject({ text: 'cloud answer' });
  expect(api.post).toHaveBeenCalledTimes(1);
});
