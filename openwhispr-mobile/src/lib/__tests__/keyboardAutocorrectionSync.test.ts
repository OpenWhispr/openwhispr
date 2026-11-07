import {
  setKeyboardAutocorrectionEnabled,
  setKeyboardAutocorrectionLanguages,
  startKeyboardAutocorrectionSync,
} from '@/lib/keyboardAutocorrectionSync';
import { useConfigStore } from '@/store/useConfigStore';

const store: Record<string, string> = {};

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
  },
  APP_GROUP_KEYS: {
    KEYBOARD_AUTOCORRECTION_ENABLED: 'keyboard_autocorrection_enabled',
    KEYBOARD_AUTOCORRECTION_LANGUAGES: 'keyboard_autocorrection_languages',
  },
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: { saveConfig: jest.fn(async () => {}) },
}));

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('keyboard autocorrection mirror', () => {
  it('is on for a config that never set it', () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud' } as any });
    const stop = startKeyboardAutocorrectionSync();
    expect(store.keyboard_autocorrection_enabled).toBe('1');
    expect(store.keyboard_autocorrection_languages).toBe('de,en');
    stop();
  });

  it('mirrors the saved languages, normalized', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', keyboardAutocorrectionLanguages: ['en', 'xx'] } as any,
    });
    const stop = startKeyboardAutocorrectionSync();
    expect(store.keyboard_autocorrection_languages).toBe('en');
    stop();
  });

  it('the language picker writes the key at once and saves config', async () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud' } as any });
    setKeyboardAutocorrectionLanguages(['en']);
    expect(store.keyboard_autocorrection_languages).toBe('en');
    await new Promise((resolve) => setImmediate(resolve));
    expect(useConfigStore.getState().config?.keyboardAutocorrectionLanguages).toEqual(['en']);
  });

  it('mirrors a saved off and later config changes', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', keyboardAutocorrectionEnabled: false } as any,
    });
    const stop = startKeyboardAutocorrectionSync();
    expect(store.keyboard_autocorrection_enabled).toBe('0');
    useConfigStore.setState({
      config: { defaultMode: 'cloud', keyboardAutocorrectionEnabled: true } as any,
    });
    expect(store.keyboard_autocorrection_enabled).toBe('1');
    stop();
  });

  it('the Settings switch writes the key at once and saves config', async () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud' } as any });
    setKeyboardAutocorrectionEnabled(false);
    expect(store.keyboard_autocorrection_enabled).toBe('0');
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(useConfigStore.getState().config?.keyboardAutocorrectionEnabled).toBe(false);
  });
});
