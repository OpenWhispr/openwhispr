import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();
let mockConfig: Record<string, unknown> | null = null;

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));

import PreferencesScreen from '../PreferencesScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = null;
  Platform.OS = 'ios';
});

describe('PreferencesScreen — keyboard autocorrection row', () => {
  it('shows German and English by default and opens the autocorrection screen', () => {
    render(<PreferencesScreen />);
    expect(screen.getByText('German, English')).toBeTruthy();
    fireEvent.press(screen.getByText('Autocorrection'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/keyboard-autocorrection');
  });

  it('shows the selected languages, or Off', () => {
    mockConfig = { defaultMode: 'cloud', keyboardAutocorrectionLanguages: ['en'] };
    const { unmount } = render(<PreferencesScreen />);
    expect(screen.getByText('English')).toBeTruthy();
    unmount();
    mockConfig = { defaultMode: 'cloud', keyboardAutocorrectionEnabled: false };
    render(<PreferencesScreen />);
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('is not offered on Android, which has no OpenWhispr keyboard', () => {
    Platform.OS = 'android';
    render(<PreferencesScreen />);
    expect(screen.queryByText('Autocorrection')).toBeNull();
  });
});
