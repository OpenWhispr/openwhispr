import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: { defaultMode: 'cloud', keyboardLetterLayout: 'de' } }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));

import PreferencesScreen from '../PreferencesScreen';

const originalOS = Platform.OS;

afterEach(() => {
  Platform.OS = originalOS;
  jest.clearAllMocks();
});

describe('PreferencesScreen — keyboard layout', () => {
  it('shows the chosen layout and opens the picker on iOS', () => {
    Platform.OS = 'ios';
    render(<PreferencesScreen />);
    expect(screen.getByText('German')).toBeTruthy();
    fireEvent.press(screen.getByText('Keyboard Layout'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/keyboard-layout');
  });

  it('hides the row on Android, which has no OpenWhispr keyboard', () => {
    Platform.OS = 'android';
    render(<PreferencesScreen />);
    expect(screen.queryByText('Keyboard Layout')).toBeNull();
  });
});
