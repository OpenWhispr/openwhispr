import fs from 'fs';
import path from 'path';
import { setKeyboardLetterLayout, startKeyboardLayoutSync } from '@/lib/keyboardLayoutSync';
import {
  KEYBOARD_LETTER_LAYOUTS,
  coerceLetterLayout,
  letterLayoutLabel,
} from '@/lib/keyboardLayout';
import { useConfigStore } from '@/store/useConfigStore';

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
  APP_GROUP_KEYS: { KEYBOARD_LETTER_LAYOUT: 'keyboard_letter_layout' },
}));

let mockAppStateListener: ((state: string) => void) | undefined;
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      mockAppStateListener = listener;
      return { remove: () => (mockAppStateListener = undefined) };
    },
  },
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: { saveConfig: jest.fn(async () => {}) },
}));

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  useConfigStore.setState({ config: { defaultMode: 'cloud' }, isLoading: false });
});

describe('keyboardLayout', () => {
  it('reads unknown and missing values as English', () => {
    expect(coerceLetterLayout(undefined)).toBe('en');
    expect(coerceLetterLayout('xx')).toBe('en');
    expect(coerceLetterLayout('fr_CH')).toBe('fr_CH');
    expect(letterLayoutLabel('de')).toBe('German');
  });

  it('offers exactly the layouts the keyboard extension knows', () => {
    const swift = fs.readFileSync(
      path.join(__dirname, '../../../plugins/keyboard-extension/ios/KeyboardViewController.swift'),
      'utf8',
    );
    const body = swift.match(
      /enum KeyboardLetterLayout: String, CaseIterable \{([\s\S]*?)\n {2}init/,
    );
    expect(body).not.toBeNull();
    const swiftValues = [...body![1].matchAll(/case \w+ = "([^"]+)"/g)].map((match) => match[1]);
    expect(swiftValues).toEqual(KEYBOARD_LETTER_LAYOUTS.map((layout) => layout.value));
  });
});

describe('keyboardLayoutSync', () => {
  it('mirrors English when nothing is chosen, then follows config', () => {
    const stop = startKeyboardLayoutSync();
    expect(store.keyboard_letter_layout).toBe('en');

    useConfigStore.setState({ config: { defaultMode: 'cloud', keyboardLetterLayout: 'de' } });
    expect(store.keyboard_letter_layout).toBe('de');
    stop();
  });

  it('repairs a key changed behind its back when the app comes to the foreground', () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud', keyboardLetterLayout: 'fr_CH' } });
    const stop = startKeyboardLayoutSync();
    store.keyboard_letter_layout = 'bogus';
    mockAppStateListener?.('active');
    expect(store.keyboard_letter_layout).toBe('fr_CH');
    stop();
    expect(mockAppStateListener).toBeUndefined();
  });

  it('writes the App Group key at once and saves the choice in config', async () => {
    setKeyboardLetterLayout('fr_CH');
    expect(store.keyboard_letter_layout).toBe('fr_CH');
    await Promise.resolve();
    expect(useConfigStore.getState().config?.keyboardLetterLayout).toBe('fr_CH');
  });
});
