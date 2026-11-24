const mockConfig: { androidSpeechModel?: string } = {};
const mockReady = new Set<string>();
const mockUnsupported = new Set<string>();
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'moonshine-tiny': { kind: 'speech' },
    'moonshine-small': { kind: 'speech' },
    'meeting-speakers': { kind: 'diarization' },
    'parakeet-v3': { kind: 'speech', meetings: true },
    'parakeet-next': { kind: 'speech', meetings: true },
  },
  modelSupported: (id: string) => !mockUnsupported.has(id),
  modelReady: async (id: string) => mockReady.has(id),
}));
jest.mock('../speechCapabilities', () => ({
  speechModelSupportsLanguages: (model: string, languages: string[]) =>
    model.startsWith('parakeet') || languages.every((language) => language === 'en'),
}));

import {
  canTranscribeMeetings,
  meetingSpeechModel,
  meetingSpeechModels,
  selectedSpeechModel,
} from '../speechSelection';

beforeEach(() => {
  delete mockConfig.androidSpeechModel;
  mockReady.clear();
  mockUnsupported.clear();
});

it('lists only the speech models the catalog marks for meetings', () => {
  expect(meetingSpeechModels()).toEqual(['parakeet-v3', 'parakeet-next']);
  expect(canTranscribeMeetings('moonshine-small' as never)).toBe(false);
  expect(canTranscribeMeetings('meeting-speakers' as never)).toBe(false);
});

it('keeps any catalog speech model as the dictation choice', () => {
  mockConfig.androidSpeechModel = 'parakeet-next';
  expect(selectedSpeechModel()).toBe('parakeet-next');
  mockConfig.androidSpeechModel = 'gone-model';
  expect(selectedSpeechModel()).toBe('parakeet-v3');
});

it('dictates with Parakeet v3 when no speech model was picked, as Settings shows', () => {
  expect(selectedSpeechModel()).toBe('parakeet-v3');
});

it('falls back to the first catalog model where Parakeet v3 cannot run', () => {
  mockUnsupported.add('parakeet-v3');
  expect(selectedSpeechModel()).toBe('moonshine-tiny');
});

it('records a meeting with a meeting model while dictation stays on Moonshine', async () => {
  mockConfig.androidSpeechModel = 'moonshine-small';
  mockReady.add('moonshine-small');
  expect(await meetingSpeechModel(['en'])).toBeNull();
  mockReady.add('parakeet-next');
  expect(await meetingSpeechModel(['en'])).toBe('parakeet-next');
});

it('prefers the dictation model when it can do meetings', async () => {
  mockConfig.androidSpeechModel = 'parakeet-next';
  mockReady.add('parakeet-v3');
  mockReady.add('parakeet-next');
  expect(await meetingSpeechModel(['en'])).toBe('parakeet-next');
});
