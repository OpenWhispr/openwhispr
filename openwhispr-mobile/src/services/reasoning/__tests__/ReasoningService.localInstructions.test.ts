import { ReasoningService } from '../ReasoningService';
import { LocalReasoningService } from '../LocalReasoningService';
import { getInferenceSelection } from '@/lib/inferenceRouting';
import { api } from '@/lib/apiClient';

jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('@/lib/inferenceRouting', () => ({
  getInferenceSelection: jest.fn(),
  resolveMobileProviderRoute: jest.fn(),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
jest.mock('@/lib/localReasoning', () => ({
  isLocalReasoningRequired: (options: { isPrivateNote?: boolean }): boolean =>
    options.isPrivateNote === true,
  getLocalReasoningReadiness: async (): Promise<{ status: string }> => ({ status: 'ready' }),
  fitsLocalReasoningBudget: async (): Promise<boolean> => true,
  getLocalReasoningUnavailableMessage: (): string => 'Local unavailable',
  LocalReasoningError: class extends Error {
    constructor(_code: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('../LocalReasoningService', () => ({
  ...jest.requireActual('../LocalReasoningService'),
  LocalReasoningService: { processText: jest.fn() },
}));

const { buildLocalReasoningInstructions } = jest.requireActual(
  '../LocalReasoningService',
) as typeof import('../LocalReasoningService');

beforeEach(() => {
  jest.clearAllMocks();
  // Implementations set by one test must not leak into the next; each test
  // establishes the selection, local answer and API reply it relies on.
  jest.mocked(LocalReasoningService.processText).mockReset();
  jest.mocked(getInferenceSelection).mockReset();
  jest.mocked(api.post).mockReset();
});

it('adds language, tone and dictionary instructions exactly once on the On-Device path', async () => {
  jest.mocked(getInferenceSelection).mockReturnValue({ mode: 'local' });
  const processText = jest.mocked(LocalReasoningService.processText);
  processText.mockImplementation(async (request) => ({
    text: buildLocalReasoningInstructions(request),
    model: 'local',
  }));
  const result = await ReasoningService.processText({
    text: 'um hello',
    tone: 'formal',
    language: 'fr',
    customDictionary: ['OpenWhispr'],
    inferenceScope: 'cleanup',
  });
  const count = (needle: string): number => result.text.split(needle).length - 1;
  expect(count('You MUST write your entire output in French')).toBe(1);
  expect(count('Custom Dictionary')).toBe(1);
});

it('answers Cloud note chat from OpenWhispr Cloud even when the on-device model could', async () => {
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
  expect(LocalReasoningService.processText).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});
