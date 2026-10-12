import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
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

import PreferencesScreen from '../PreferencesScreen';

beforeEach(() => {
  jest.clearAllMocks();
});

// The banner is inferential and dismissible, so it cannot be the only door to
// recovery: a mid-version revoke, or one dismissal, leaves the keyboard panel
// telling users to open an app that then shows them nothing.
describe('PreferencesScreen — Full Access entry point', () => {
  it('offers a permanent Full Access row in the Keyboard section', () => {
    render(<PreferencesScreen />);
    expect(screen.getByText('Full Access')).toBeTruthy();
  });

  it('opens the recovery screen rather than jumping straight to iOS Settings', () => {
    // Linking.openSettings() only reaches Settings > OpenWhispr; Full Access is
    // two levels deeper, so the row must go through the screen that teaches the
    // taps and plays the PiP tutorial over Settings.
    render(<PreferencesScreen />);
    fireEvent.press(screen.getByText('Full Access'));
    expect(mockRouterPush).toHaveBeenCalledWith('/keyboard-full-access');
  });
});
