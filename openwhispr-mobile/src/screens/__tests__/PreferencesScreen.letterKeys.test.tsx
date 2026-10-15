import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const store: Record<string, string> = {};

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// nativewind's cssInterop breaks jest's transform; same stub the banner suite uses.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: null }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
  },
  APP_GROUP_KEYS: { KEYBOARD_LETTERS_ENABLED: 'keyboard_letters_enabled' },
}));

import PreferencesScreen from '../PreferencesScreen';

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

// The keyboard is for dictation first: it opens on numbers and punctuation, and
// only shows its letter layout when the user turns Letter keys on here.
describe('PreferencesScreen — Letter keys', () => {
  it('is off by default', () => {
    render(<PreferencesScreen />);
    expect(screen.getByLabelText('Letter keys').props.value).toBe(false);
  });

  it('shows the saved choice', () => {
    store.keyboard_letters_enabled = '1';
    render(<PreferencesScreen />);
    expect(screen.getByLabelText('Letter keys').props.value).toBe(true);
  });

  it('tells the keyboard when letters are turned on and off', () => {
    render(<PreferencesScreen />);
    fireEvent(screen.getByLabelText('Letter keys'), 'valueChange', true);
    expect(store.keyboard_letters_enabled).toBe('1');
    expect(screen.getByLabelText('Letter keys').props.value).toBe(true);

    fireEvent(screen.getByLabelText('Letter keys'), 'valueChange', false);
    expect(store.keyboard_letters_enabled).toBe('0');
  });
});
