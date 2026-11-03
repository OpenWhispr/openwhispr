const mockGetConfig = jest.fn();
const mockSaveConfig = jest.fn();
const mockClearConfig = jest.fn();
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    getConfig: () => mockGetConfig(),
    saveConfig: (config: unknown) => mockSaveConfig(config),
    clearConfig: () => mockClearConfig(),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ resetToDefault: jest.fn() }) },
}));
let useConfigStore: (typeof import('../useConfigStore'))['useConfigStore'];
function deferredSave() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  jest.resetModules();
  useConfigStore = require('../useConfigStore').useConfigStore;
  jest.clearAllMocks();
  mockSaveConfig.mockResolvedValue(undefined);
  mockClearConfig.mockResolvedValue(undefined);
  useConfigStore.setState({
    config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
    isLoading: false,
    error: null,
  });
});

it('publishes the default consent change only after the upstream save completes', async () => {
  const save = deferredSave();
  mockSaveConfig.mockReturnValueOnce(save.promise);
  const update = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
  try {
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(true);
  } finally {
    save.resolve();
    await update;
  }
  expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
});

it('keeps the upstream default configuration when a consent save fails', async () => {
  mockSaveConfig.mockRejectedValueOnce(new Error('fixture disk full'));
  await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
  expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(true);
  expect(useConfigStore.getState().error).toBe('fixture disk full');
});

it('starts default concurrent writes with their original snapshots', async () => {
  const first = deferredSave(),
    second = deferredSave();
  mockSaveConfig.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const older = useConfigStore.getState().updateConfig({ preferredLanguage: 'fr' });
  const newer = useConfigStore.getState().updateConfig({ cloudBackupEnabled: false });
  try {
    expect(mockSaveConfig).toHaveBeenCalledTimes(2);
    expect(mockSaveConfig.mock.calls[1][0]).not.toHaveProperty('preferredLanguage');
  } finally {
    first.resolve();
    second.resolve();
    await Promise.all([older, newer]);
  }
  expect(useConfigStore.getState().config).not.toHaveProperty('preferredLanguage');
});

it('keeps the upstream loading publication after the first concurrent default write', async () => {
  const first = deferredSave(),
    second = deferredSave();
  mockSaveConfig.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const older = useConfigStore.getState().updateConfig({ preferredLanguage: 'fr' });
  const newer = useConfigStore.getState().updateConfig({ cloudBackupEnabled: false });
  try {
    first.resolve();
    await older;
    expect(useConfigStore.getState().isLoading).toBe(false);
  } finally {
    first.resolve();
    second.resolve();
    await Promise.all([older, newer]);
  }
});

it('loads the upstream stored consent and clears an earlier default save error', async () => {
  mockSaveConfig.mockRejectedValueOnce(new Error('fixture disk full'));
  await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
  mockGetConfig.mockResolvedValue({
    defaultMode: 'cloud',
    usageAnalyticsEnabled: true,
    localModeUpgraded: true,
    noteChatSplit: true,
    notesLocalModeSplit: true,
  });
  await useConfigStore.getState().loadConfig();
  expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(true);
  expect(useConfigStore.getState().error).toBeNull();
});

it('preserves the upstream rejection before saving when a default subscriber throws', async () => {
  const unsubscribe = useConfigStore.subscribe(() => {
    throw new Error('fixture subscriber failed');
  });
  try {
    await expect(
      useConfigStore.getState().updateConfig({ preferredLanguage: 'fr' }),
    ).rejects.toThrow('fixture subscriber failed');
    expect(mockSaveConfig).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

it('keeps the upstream snapshot when a subscriber queues consent withdrawal', async () => {
  let queued = false;
  let withdrawal = Promise.resolve();
  const unsubscribe = useConfigStore.subscribe((state) => {
    if (state.isLoading && !queued) {
      queued = true;
      withdrawal = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    }
  });
  try {
    await useConfigStore.getState().updateConfig({ preferredLanguage: 'fr' });
    await withdrawal;
    expect(useConfigStore.getState().config).toMatchObject({
      usageAnalyticsEnabled: true,
      preferredLanguage: 'fr',
    });
  } finally {
    unsubscribe();
  }
});
