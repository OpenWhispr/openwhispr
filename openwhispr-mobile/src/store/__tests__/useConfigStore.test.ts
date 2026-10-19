const mockGetConfig = jest.fn();
const mockSaveConfig = jest.fn();

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    getConfig: () => mockGetConfig(),
    saveConfig: (config: unknown) => mockSaveConfig(config),
    clearConfig: jest.fn(),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ resetToDefault: jest.fn() }) },
}));

import { useConfigStore } from '../useConfigStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockSaveConfig.mockResolvedValue(undefined);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

// A config from before Local Mode's Cloud defaults must never reach Cloud with them.
it('upgrades a Local Mode config from before the Cloud defaults before anything reads it', async () => {
  mockGetConfig.mockResolvedValue({
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  });

  await useConfigStore.getState().loadConfig();

  const upgraded = {
    defaultMode: 'private',
    localModeUpgraded: true,
    noteChatSplit: true,
    noteChatEnabled: true,
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  };
  expect(useConfigStore.getState().config).toEqual(upgraded);
  expect(mockSaveConfig).toHaveBeenCalledWith(upgraded);
});

it('still upgrades the loaded config when saving it fails', async () => {
  mockGetConfig.mockResolvedValue({ defaultMode: 'private' });
  mockSaveConfig.mockRejectedValue(new Error('disk full'));

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toMatchObject({
    localModeUpgraded: true,
    pinnedInference: ['upload', 'cleanup'],
  });
  expect(useConfigStore.getState().error).toBeNull();
});

it('leaves an upgraded config alone', async () => {
  const config = { defaultMode: 'private', localModeUpgraded: true, noteChatSplit: true };
  mockGetConfig.mockResolvedValue(config);

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toBe(config);
  expect(mockSaveConfig).not.toHaveBeenCalled();
});

it('starts a new install on the Cloud defaults', async () => {
  mockGetConfig.mockResolvedValue(null);

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toMatchObject({
    localModeUpgraded: true,
    noteChatSplit: true,
  });
  expect(mockSaveConfig).not.toHaveBeenCalled();
});

// Note chat once shared the voice assistant's setting, so it keeps that setting after updating.
it('splits note chat from the voice assistant before anything reads the config', async () => {
  const groq = {
    mode: 'providers',
    providerId: 'groq',
    modelId: 'llama',
    credentialRef: 'provider.groq',
  };
  mockGetConfig.mockResolvedValue({
    defaultMode: 'cloud',
    localModeUpgraded: true,
    inference: { agent: groq },
  });

  await useConfigStore.getState().loadConfig();

  const split = {
    defaultMode: 'cloud',
    localModeUpgraded: true,
    noteChatSplit: true,
    noteChatEnabled: true,
    inference: { agent: groq, noteChat: groq },
  };
  expect(useConfigStore.getState().config).toEqual(split);
  expect(mockSaveConfig).toHaveBeenCalledWith(split);
});
