import { areKeyboardLettersEnabled, setKeyboardLettersEnabled } from '@/lib/keyboardLetters';

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
    KEYBOARD_LETTERS_ENABLED: 'keyboard_letters_enabled',
  },
}));

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('keyboard Letter keys setting', () => {
  it('is off until the user turns it on', () => {
    expect(areKeyboardLettersEnabled()).toBe(false);
  });

  it('writes "1" for on, the value the keyboard reads as letters on', () => {
    setKeyboardLettersEnabled(true);
    expect(store.keyboard_letters_enabled).toBe('1');
    expect(areKeyboardLettersEnabled()).toBe(true);
  });

  it('writes "0" for off', () => {
    setKeyboardLettersEnabled(true);
    setKeyboardLettersEnabled(false);
    expect(store.keyboard_letters_enabled).toBe('0');
    expect(areKeyboardLettersEnabled()).toBe(false);
  });

  it('treats any other stored value as off, as the keyboard does', () => {
    store.keyboard_letters_enabled = 'true';
    expect(areKeyboardLettersEnabled()).toBe(false);
  });
});
