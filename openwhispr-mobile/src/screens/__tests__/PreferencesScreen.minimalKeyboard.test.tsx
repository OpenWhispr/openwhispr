import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockToggle = jest.fn();
let mockConfig: { minimalKeyboardEnabled?: boolean } | null = null;

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({
  useConfigToggle: (key: string) => (key === 'minimalKeyboardEnabled' ? mockToggle : jest.fn()),
}));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));

import PreferencesScreen from '../PreferencesScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = null;
});

function minimalSwitch() {
  return screen.getAllByRole('switch')[1];
}

it('offers a minimal keyboard switch that defaults to off', () => {
  render(<PreferencesScreen />);
  expect(screen.getByText('Minimal Keyboard')).toBeTruthy();
  expect(
    screen.getByText(
      'Show only tone, dictation, and the voice assistant. Hide typing keys to save screen space.',
    ),
  ).toBeTruthy();
  expect(minimalSwitch().props.value).toBe(false);
  fireEvent(minimalSwitch(), 'valueChange', true);
  expect(mockToggle).toHaveBeenCalledWith(true);
});

it('does not offer the iOS-only layout switch on Android', () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'android');
  try {
    render(<PreferencesScreen />);
    expect(screen.queryByText('Minimal Keyboard')).toBeNull();
    expect(
      screen.queryByText(
        'Show only tone, dictation, and the voice assistant. Hide typing keys to save screen space.',
      ),
    ).toBeNull();
  } finally {
    platform.restore();
  }
});

it('shows the saved preference and can switch back to the full keyboard', () => {
  mockConfig = { minimalKeyboardEnabled: true };
  render(<PreferencesScreen />);
  expect(minimalSwitch().props.value).toBe(true);
  fireEvent(minimalSwitch(), 'valueChange', false);
  expect(mockToggle).toHaveBeenCalledWith(false);
});
