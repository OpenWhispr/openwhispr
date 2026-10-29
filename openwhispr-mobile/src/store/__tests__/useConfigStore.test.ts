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
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetModules();
  useConfigStore = require('../useConfigStore').useConfigStore;
  jest.clearAllMocks();
  mockSaveConfig.mockResolvedValue(undefined);
  mockClearConfig.mockResolvedValue(undefined);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

describe('analytics consent persistence', () => {
  beforeEach(() => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
    });
  });

  it('withdraws consent and notifies subscribers before storage completes', async () => {
    const save = deferredSave();
    mockSaveConfig.mockReturnValueOnce(save.promise);
    const observed: boolean[] = [];
    const unsubscribe = useConfigStore.subscribe((state) => {
      observed.push(state.config?.usageAnalyticsEnabled ?? true);
    });
    const update = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    try {
      expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
      expect(observed).not.toContain(true);
      expect(observed).toContain(false);
    } finally {
      save.resolve();
      await update;
      unsubscribe();
    }
  });

  it('keeps consent withdrawn when persistence fails and reports the save error', async () => {
    mockSaveConfig.mockRejectedValueOnce(new Error('disk full'));
    await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(useConfigStore.getState().error).toBe('disk full');
  });

  it('enables collection only after opt-in is successfully persisted', async () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud', usageAnalyticsEnabled: false } });
    const save = deferredSave();
    mockSaveConfig.mockReturnValueOnce(save.promise);
    const update = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: true });
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
    save.resolve();
    await update;
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(true);
  });

  it('keeps collection disabled after a failed opt-in', async () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud', usageAnalyticsEnabled: false } });
    mockSaveConfig.mockRejectedValueOnce(new Error('disk full'));
    await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: true });
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
  });

  it('does not let an older config save restore consent or overwrite its durable withdrawal', async () => {
    const olderSave = deferredSave();
    mockSaveConfig.mockReturnValueOnce(olderSave.promise);
    const olderUpdate = useConfigStore.getState().updateConfig({ cloudBackupEnabled: true });
    const withdrawal = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    try {
      expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
      expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    } finally {
      olderSave.resolve();
      await Promise.all([olderUpdate, withdrawal]);
    }
    expect(useConfigStore.getState().config).toMatchObject({
      usageAnalyticsEnabled: false,
      cloudBackupEnabled: true,
    });
    expect(mockSaveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ usageAnalyticsEnabled: false, cloudBackupEnabled: true }),
    );
  });

  it('does not publish an opt-in overtaken by a newer withdrawal', async () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud', usageAnalyticsEnabled: false } });
    const olderSave = deferredSave();
    mockSaveConfig.mockReturnValueOnce(olderSave.promise);
    const observed: boolean[] = [];
    const unsubscribe = useConfigStore.subscribe((state) => {
      observed.push(state.config?.usageAnalyticsEnabled ?? true);
    });
    const optIn = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: true });
    const withdrawal = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    olderSave.resolve();
    await Promise.all([optIn, withdrawal]);
    unsubscribe();
    expect(observed).not.toContain(true);
    expect(mockSaveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ usageAnalyticsEnabled: false }),
    );
  });

  it('continues after an older save fails and clears its error when withdrawal is persisted', async () => {
    const olderSave = deferredSave();
    mockSaveConfig.mockReturnValueOnce(olderSave.promise);
    const olderUpdate = useConfigStore.getState().updateConfig({ cloudBackupEnabled: true });
    const withdrawal = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    olderSave.reject(new Error('temporary storage failure'));
    await Promise.all([olderUpdate, withdrawal]);
    expect(useConfigStore.getState()).toMatchObject({
      config: { usageAnalyticsEnabled: false },
      error: null,
      isLoading: false,
    });
  });

  it('keeps failed withdrawal and its error when Home requests config hydration again', async () => {
    mockSaveConfig.mockRejectedValueOnce(new Error('disk full'));
    await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    mockGetConfig.mockResolvedValue({ defaultMode: 'cloud', usageAnalyticsEnabled: true });
    await useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState()).toMatchObject({
      config: { usageAnalyticsEnabled: false },
      error: 'disk full',
    });
  });

  it('does not publish an older hydration read over a newer withdrawal', async () => {
    useConfigStore.setState({ config: null });
    let resolve!: (config: unknown) => void;
    mockGetConfig.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const load = useConfigStore.getState().loadConfig();
    const withdrawal = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    resolve({
      defaultMode: 'private',
      usageAnalyticsEnabled: true,
      preferredLanguage: 'fr',
      androidSpeechModel: 'moonshine-small',
      androidHistoryDays: 7,
    });
    await Promise.all([load, withdrawal]);
    expect(useConfigStore.getState().config).toMatchObject({
      usageAnalyticsEnabled: false,
      defaultMode: 'private',
      preferredLanguage: 'fr',
      androidSpeechModel: 'moonshine-small',
      androidHistoryDays: 7,
    });
    expect(mockSaveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ usageAnalyticsEnabled: false }),
    );
  });

  it('does not publish defaults over a withdrawal when an older hydration read fails', async () => {
    useConfigStore.setState({ config: null });
    let reject!: (error: Error) => void;
    mockGetConfig.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const load = useConfigStore.getState().loadConfig();
    const withdrawal = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    reject(new Error('read failed'));
    await Promise.all([load, withdrawal]);
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
  });

  it('does not let an older reset erase a newer withdrawal', async () => {
    const clear = deferredSave();
    mockClearConfig.mockReturnValueOnce(clear.promise);
    const reset = useConfigStore.getState().resetConfig();
    const withdrawal = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    clear.resolve();
    await Promise.all([reset, withdrawal]);
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(mockSaveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ usageAnalyticsEnabled: false }),
    );
  });

  it('keeps disabled consent if an explicit reset fails', async () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud', usageAnalyticsEnabled: false } });
    mockClearConfig.mockRejectedValueOnce(new Error('clear failed'));
    await useConfigStore.getState().resetConfig();
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(useConfigStore.getState().error).toBe('clear failed');
  });

  it('applies an explicit reset only after it succeeds and releases the runtime override', async () => {
    await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    const clear = deferredSave();
    mockClearConfig.mockReturnValueOnce(clear.promise);
    const reset = useConfigStore.getState().resetConfig();
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
    clear.resolve();
    await reset;
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled ?? true).toBe(true);
  });

  it('allows a later successfully saved opt-in after failed withdrawal and reload', async () => {
    mockSaveConfig.mockRejectedValueOnce(new Error('disk full'));
    await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    mockGetConfig.mockResolvedValue({
      defaultMode: 'cloud',
      usageAnalyticsEnabled: true,
      localModeUpgraded: true,
      noteChatSplit: true,
      notesLocalModeSplit: true,
    });
    await useConfigStore.getState().loadConfig();
    await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: true });
    await useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(true);
    expect(useConfigStore.getState().error).toBeNull();
  });
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
    notesLocalModeSplit: true,
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
      notes: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup', 'notes'],
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
    pinnedInference: ['upload', 'cleanup', 'notes'],
  });
  expect(useConfigStore.getState().error).toBeNull();
});

it('leaves an upgraded config alone', async () => {
  const config = {
    defaultMode: 'private',
    localModeUpgraded: true,
    noteChatSplit: true,
    notesLocalModeSplit: true,
  };
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
    notesLocalModeSplit: true,
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
    notesLocalModeSplit: true,
    inference: { agent: groq, noteChat: groq },
  };
  expect(useConfigStore.getState().config).toEqual(split);
  expect(mockSaveConfig).toHaveBeenCalledWith(split);
});

// Local Mode once formatted notes on this iPhone whatever was saved, so the update keeps a Local
// Mode config's note formatting there unless the user chose otherwise.
describe('note formatting leaving Local Mode', () => {
  const upgradedBefore = { localModeUpgraded: true, noteChatSplit: true };

  it('holds note formatting On-Device for a Local Mode config with nothing saved', async () => {
    mockGetConfig.mockResolvedValue({ ...upgradedBefore, defaultMode: 'private' });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config).toMatchObject({
      notesLocalModeSplit: true,
      inference: { notes: { mode: 'local' } },
      pinnedInference: ['notes'],
    });
  });

  it('holds a note formatting Cloud hold On-Device too', async () => {
    mockGetConfig.mockResolvedValue({
      ...upgradedBefore,
      defaultMode: 'private',
      inference: { notes: { mode: 'openwhispr' } },
      pinnedInference: ['notes'],
    });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config).toMatchObject({
      inference: { notes: { mode: 'local' } },
      pinnedInference: ['notes'],
    });
  });

  it("keeps the user's own note formatting choice", async () => {
    const groq = { mode: 'providers', providerId: 'groq', modelId: 'llama' };
    mockGetConfig.mockResolvedValue({
      ...upgradedBefore,
      defaultMode: 'private',
      inference: { notes: groq },
    });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config?.inference?.notes).toEqual(groq);
    expect(useConfigStore.getState().config?.pinnedInference).toBeUndefined();
  });

  it('leaves a config outside Local Mode alone', async () => {
    mockGetConfig.mockResolvedValue({ ...upgradedBefore, defaultMode: 'cloud' });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config).toEqual({
      ...upgradedBefore,
      defaultMode: 'cloud',
      notesLocalModeSplit: true,
    });
  });
});
