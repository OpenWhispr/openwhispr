import fixtures from '@/config/prompts/__tests__/retiredPromptFixtures.json';

// The store installs expo-sqlite's localStorage shim itself; under jest that
// shim has no native backing, so stub the install and supply a fake storage.
jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-crypto', () => {
  const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: jest.fn(async (_algorithm: string, text: string) =>
      nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    ),
  };
});

type StoreModule = typeof import('@/store/useCustomPromptsStore');

function createFakeLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
    key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
    get length(): number {
      return store.size;
    },
  };
}

// Hydration runs at module load, so each test seeds storage before requiring.
function loadStore(initial?: Record<string, string>): StoreModule {
  if (initial !== undefined) globalThis.localStorage = createFakeLocalStorage(initial);
  jest.resetModules();
  return require('@/store/useCustomPromptsStore') as StoreModule;
}

beforeEach(() => {
  jest.clearAllMocks();
  Reflect.deleteProperty(globalThis, 'localStorage');
});

afterEach(() => {
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('useCustomPromptsStore hydration', () => {
  it('reads the stored cleanup override and its timestamp at load', () => {
    const { useCustomPromptsStore } = loadStore({
      'customPrompt.cleanup': 'Keep it terse.',
      'customPrompt.cleanup.updatedAt': '1725000000000',
    });
    const state = useCustomPromptsStore.getState();
    expect(state.customPrompts.cleanup).toBe('Keep it terse.');
    expect(state.updatedAt.cleanup).toBe(1725000000000);
  });

  it('defaults every kind to "" with no timestamp when nothing is stored', () => {
    const { useCustomPromptsStore } = loadStore({});
    const state = useCustomPromptsStore.getState();
    expect(state.customPrompts).toEqual({
      cleanup: '',
      dictationAgent: '',
      translate: '',
      chatAgent: '',
    });
    expect(state.updatedAt).toEqual({});
  });

  it('falls back to defaults when localStorage is missing', () => {
    const { useCustomPromptsStore } = loadStore();
    expect(useCustomPromptsStore.getState().customPrompts.cleanup).toBe('');
  });

  it('falls back to defaults when storage reads throw', () => {
    globalThis.localStorage = {
      ...createFakeLocalStorage(),
      getItem: () => {
        throw new Error('storage unavailable');
      },
    };
    jest.resetModules();
    const { useCustomPromptsStore } = require('@/store/useCustomPromptsStore') as StoreModule;
    expect(useCustomPromptsStore.getState().customPrompts.cleanup).toBe('');
  });
});

describe('useCustomPromptsStore writes', () => {
  it('persists the value and a fresh timestamp under the desktop key names', () => {
    jest.useFakeTimers({ now: 1725000123456 });
    const { useCustomPromptsStore } = loadStore({});
    useCustomPromptsStore.getState().setCustomPrompt('cleanup', 'Use bullets.');

    expect(globalThis.localStorage.getItem('customPrompt.cleanup')).toBe('Use bullets.');
    expect(globalThis.localStorage.getItem('customPrompt.cleanup.updatedAt')).toBe('1725000123456');
    const state = useCustomPromptsStore.getState();
    expect(state.customPrompts.cleanup).toBe('Use bullets.');
    expect(state.updatedAt.cleanup).toBe(1725000123456);
  });

  it('honours an explicit updatedAt so a synced value keeps its remote timestamp', () => {
    const { useCustomPromptsStore } = loadStore({});
    useCustomPromptsStore.getState().setCustomPrompt('cleanup', 'Remote.', {
      updatedAt: 1700000000000,
    });
    expect(useCustomPromptsStore.getState().updatedAt.cleanup).toBe(1700000000000);
    expect(globalThis.localStorage.getItem('customPrompt.cleanup.updatedAt')).toBe('1700000000000');
  });

  it('reset writes "" rather than removing the key, and bumps the timestamp', () => {
    jest.useFakeTimers({ now: 1725000999999 });
    const { useCustomPromptsStore } = loadStore({
      'customPrompt.cleanup': 'Custom.',
      'customPrompt.cleanup.updatedAt': '1',
    });
    useCustomPromptsStore.getState().resetCustomPrompt('cleanup');

    expect(globalThis.localStorage.getItem('customPrompt.cleanup')).toBe('');
    expect(useCustomPromptsStore.getState().customPrompts.cleanup).toBe('');
    expect(useCustomPromptsStore.getState().updatedAt.cleanup).toBe(1725000999999);
  });

  it('still updates state when the storage write throws', () => {
    const storage = createFakeLocalStorage();
    globalThis.localStorage = {
      ...storage,
      setItem: () => {
        throw new Error('disk full');
      },
    };
    jest.resetModules();
    const { useCustomPromptsStore } = require('@/store/useCustomPromptsStore') as StoreModule;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    useCustomPromptsStore.getState().setCustomPrompt('cleanup', 'Unsaved but live.');

    expect(useCustomPromptsStore.getState().customPrompts.cleanup).toBe('Unsaved but live.');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('getActiveCustomCleanupPrompt', () => {
  it('is undefined for "" and whitespace-only stored values', () => {
    const { useCustomPromptsStore, getActiveCustomCleanupPrompt } = loadStore({
      'customPrompt.cleanup': '   \n',
    });
    expect(getActiveCustomCleanupPrompt()).toBeUndefined();
    useCustomPromptsStore.getState().setCustomPrompt('cleanup', '');
    expect(getActiveCustomCleanupPrompt()).toBeUndefined();
  });

  it('returns the live override verbatim', () => {
    const { useCustomPromptsStore, getActiveCustomCleanupPrompt } = loadStore({
      'customPrompt.cleanup': '  Verbatim.  ',
    });
    expect(getActiveCustomCleanupPrompt()).toBe('  Verbatim.  ');
    useCustomPromptsStore.getState().setCustomPrompt('cleanup', 'Live.');
    expect(getActiveCustomCleanupPrompt()).toBe('Live.');
  });
});

describe('startRetiredPromptSweep', () => {
  it('clears a retired default from storage and state, leaving the timestamp alone', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { useCustomPromptsStore, startRetiredPromptSweep } = loadStore({
      'customPrompt.cleanup': fixtures.enPreHardeningCleanupPrompt,
      'customPrompt.cleanup.updatedAt': '42',
    });
    expect(useCustomPromptsStore.getState().customPrompts.cleanup).toBe(
      fixtures.enPreHardeningCleanupPrompt,
    );

    await expect(startRetiredPromptSweep()).resolves.toEqual(['cleanup']);

    expect(globalThis.localStorage.getItem('customPrompt.cleanup')).toBeNull();
    expect(globalThis.localStorage.getItem('customPrompt.cleanup.retired')).toBe(
      fixtures.enPreHardeningCleanupPrompt,
    );
    expect(useCustomPromptsStore.getState().customPrompts.cleanup).toBe('');
    expect(useCustomPromptsStore.getState().updatedAt.cleanup).toBe(42);
    log.mockRestore();
  });

  it('leaves a user-authored prompt untouched', async () => {
    const { useCustomPromptsStore, startRetiredPromptSweep } = loadStore({
      'customPrompt.cleanup': 'Mine.',
    });
    await expect(startRetiredPromptSweep()).resolves.toEqual([]);
    expect(useCustomPromptsStore.getState().customPrompts.cleanup).toBe('Mine.');
  });

  it('resolves to no swept kinds when localStorage is missing', async () => {
    const { startRetiredPromptSweep } = loadStore();
    await expect(startRetiredPromptSweep()).resolves.toEqual([]);
  });
});
