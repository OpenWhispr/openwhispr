import { Platform } from 'react-native';
import { resolveReasoningPlacement } from '../ReasoningService';

jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('@/lib/inferenceRouting', () => ({ getInferenceSelection: jest.fn() }));
jest.mock('@/services/reasoning/LocalReasoningService', () => ({
  buildLocalReasoningInstructions: jest.fn(),
  LocalReasoningService: { processText: jest.fn() },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
}));

const originalPlatform = Platform.OS;
afterEach(() => {
  Platform.OS = originalPlatform;
});

const providerNotes = {
  inferenceScope: 'notes' as const,
  inferenceRoute: {
    mode: 'providers' as const,
    scope: 'notes' as const,
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1',
    credentialRef: 'provider.openai',
  },
};

it('fits Android note hints for local inference in private mode before a provider is chosen', () => {
  Platform.OS = 'android';
  expect(resolveReasoningPlacement(providerNotes)).toMatchObject({
    privateContent: true,
    localRequired: true,
    chosenProvider: false,
  });
});

it('honors an explicit provider choice for Android private-mode notes', () => {
  Platform.OS = 'android';
  expect(
    resolveReasoningPlacement({ ...providerNotes, routing: { sendToChosenProvider: true } }),
  ).toMatchObject({ privateContent: false, localRequired: false, chosenProvider: true });
});

it('preserves the iOS note formatting selection in private mode', () => {
  Platform.OS = 'ios';
  expect(resolveReasoningPlacement(providerNotes)).toMatchObject({
    privateContent: false,
    localRequired: false,
  });
});
