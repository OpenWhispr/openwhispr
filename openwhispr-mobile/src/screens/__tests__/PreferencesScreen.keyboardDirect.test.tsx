import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockToggles: Record<string, jest.Mock> = {};

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: null }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({
  useConfigToggle: (key: string) => (mockToggles[key] ??= jest.fn()),
}));
jest.mock('@react-native-menu/menu', () =>
  require('../../components/notes/__tests__/menuViewMock'),
);
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));

import PreferencesScreen from '../PreferencesScreen';

describe('PreferencesScreen — dictate without opening the app', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('shows the switch on iOS, off by default, and saves it when turned on', () => {
    Platform.OS = 'ios';
    render(<PreferencesScreen />);
    expect(screen.getByText('Dictate without opening OpenWhispr')).toBeTruthy();
    const toggle = screen.getByLabelText('Dictate without opening OpenWhispr');
    expect(toggle.props.value).toBe(false);
    fireEvent(toggle, 'valueChange', true);
    expect(mockToggles.keyboardDirectDictation).toHaveBeenCalledWith(true);
  });

  it('is not offered off iOS', () => {
    Platform.OS = 'android';
    render(<PreferencesScreen />);
    expect(screen.queryByText('Dictate without opening OpenWhispr')).toBeNull();
  });
});
