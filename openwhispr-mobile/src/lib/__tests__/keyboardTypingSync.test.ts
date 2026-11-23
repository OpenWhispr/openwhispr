import { startKeyboardTypingSync } from '@/lib/keyboardTypingSync';
import { useConfigStore } from '@/store/useConfigStore';
import type { UserConfig } from '@/types';

const store: Record<string, string> = {};

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
    removeItem: (key: string) => {
      delete store[key];
      return true;
    },
  },
}));

const mockAppStateListeners: ((state: string) => void)[] = [];

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppStateListeners.push(listener);
      return {
        remove: () => mockAppStateListeners.splice(mockAppStateListeners.indexOf(listener), 1),
      };
    },
  },
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: { saveConfig: jest.fn(async () => {}) },
}));

function setConfig(config: Partial<UserConfig>): void {
  useConfigStore.setState({ config: { defaultMode: 'cloud', ...config } });
}

// Lets a reconcile's config save land.
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  mockAppStateListeners.length = 0;
  for (const key of Object.keys(store)) delete store[key];
  setConfig({});
});

describe('startKeyboardTypingSync', () => {
  it('leaves language and layout to the keyboard by default, with haptics on', async () => {
    const stop = startKeyboardTypingSync();
    await settle();
    expect(store).toEqual({ keyboard_haptics_enabled: '1' });
    stop();
  });

  it('mirrors the saved preferences at start', async () => {
    setConfig({
      keyboardTypingLanguage: 'de',
      keyboardTypingLayout: 'qwerty',
      keyboardHapticsEnabled: false,
    });
    const stop = startKeyboardTypingSync();
    await settle();
    expect(store).toEqual({
      keyboard_typing_language: 'de',
      keyboard_typing_layout: 'qwerty',
      keyboard_haptics_enabled: '0',
    });
    stop();
  });

  it('follows config changes until stopped', async () => {
    const stop = startKeyboardTypingSync();
    await settle();
    setConfig({ keyboardTypingLanguage: 'en', keyboardTypingLayout: 'qwertz' });
    expect(store.keyboard_typing_language).toBe('en');
    expect(store.keyboard_typing_layout).toBe('qwertz');

    setConfig({ keyboardTypingLanguage: null, keyboardTypingLayout: null });
    expect('keyboard_typing_language' in store).toBe(false);
    expect('keyboard_typing_layout' in store).toBe(false);

    stop();
    setConfig({ keyboardTypingLanguage: 'de' });
    expect('keyboard_typing_language' in store).toBe(false);
  });

  it('mirrors and adopts "other", a language without typing help', async () => {
    setConfig({ keyboardTypingLanguage: 'other' });
    const stop = startKeyboardTypingSync();
    await settle();
    expect(store.keyboard_typing_language).toBe('other');
    stop();

    setConfig({ keyboardTypingLanguage: 'en' });
    store.keyboard_typing_language = 'other';
    const stopAgain = startKeyboardTypingSync();
    await settle();
    expect(useConfigStore.getState().config?.keyboardTypingLanguage).toBe('other');
    stopAgain();
  });

  it('mirrors and adopts the Swiss French keys', async () => {
    setConfig({ keyboardTypingLanguage: 'fr_CH' });
    const stop = startKeyboardTypingSync();
    await settle();
    expect(store.keyboard_typing_language).toBe('fr_CH');
    stop();

    setConfig({ keyboardTypingLanguage: 'en' });
    store.keyboard_typing_language = 'fr_CH';
    const stopAgain = startKeyboardTypingSync();
    await settle();
    expect(useConfigStore.getState().config?.keyboardTypingLanguage).toBe('fr_CH');
    stopAgain();
  });

  it('adopts a language the keyboard wrote while config had none', async () => {
    store.keyboard_typing_language = 'de';
    const stop = startKeyboardTypingSync();
    await settle();
    expect(useConfigStore.getState().config?.keyboardTypingLanguage).toBe('de');
    expect(store.keyboard_typing_language).toBe('de');
    stop();
  });

  it('adopts a layout the keyboard wrote over the saved one', async () => {
    setConfig({ keyboardTypingLayout: 'qwerty' });
    store.keyboard_typing_layout = 'qwertz';
    const stop = startKeyboardTypingSync();
    await settle();
    expect(useConfigStore.getState().config?.keyboardTypingLayout).toBe('qwertz');
    expect(store.keyboard_typing_layout).toBe('qwertz');
    stop();
  });

  it('adopts a keyboard change when the app comes to the foreground', async () => {
    setConfig({ keyboardTypingLanguage: 'en' });
    const stop = startKeyboardTypingSync();
    await settle();
    store.keyboard_typing_language = 'de';
    mockAppStateListeners.forEach((listener) => listener('active'));
    await settle();
    expect(useConfigStore.getState().config?.keyboardTypingLanguage).toBe('de');
    expect(store.keyboard_typing_language).toBe('de');
    stop();
    expect(mockAppStateListeners).toHaveLength(0);
  });

  it('replaces an invalid stored value from config', async () => {
    setConfig({ keyboardTypingLanguage: 'en' });
    store.keyboard_typing_language = 'fr';
    store.keyboard_typing_layout = 'azerty';
    const stop = startKeyboardTypingSync();
    await settle();
    expect(useConfigStore.getState().config?.keyboardTypingLanguage).toBe('en');
    expect(useConfigStore.getState().config?.keyboardTypingLayout).toBeUndefined();
    expect(store.keyboard_typing_language).toBe('en');
    expect('keyboard_typing_layout' in store).toBe(false);
    stop();
  });

  it('treats an unknown saved value as unset', async () => {
    setConfig({ keyboardTypingLanguage: 'fr' as never, keyboardTypingLayout: 'azerty' as never });
    const stop = startKeyboardTypingSync();
    await settle();
    expect('keyboard_typing_language' in store).toBe(false);
    expect('keyboard_typing_layout' in store).toBe(false);
    stop();
  });

  it('never touches the learned-words timestamp', async () => {
    store.keyboard_learned_words_cleared_at_ms = '123';
    const stop = startKeyboardTypingSync();
    await settle();
    expect(store.keyboard_learned_words_cleared_at_ms).toBe('123');
    stop();
  });
});
