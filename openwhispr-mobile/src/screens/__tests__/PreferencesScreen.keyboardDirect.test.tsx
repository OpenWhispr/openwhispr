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
  AppGroupStorage: {
    setItem: jest.fn(),
    removeItem: jest.fn(),
    supportsKeyboardDirectDictation: true,
  },
}));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));

import { AppGroupStorage } from '../../../modules/app-group-storage/src';
import PreferencesScreen from '../PreferencesScreen';

describe('PreferencesScreen — dictate without opening the app', () => {
  const originalOS = Platform.OS;
  const originalVersion = Object.getOwnPropertyDescriptor(Platform, 'Version');
  function setIOSVersion(version: string): void {
    Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
  }
  afterEach(() => {
    Platform.OS = originalOS;
    AppGroupStorage.supportsKeyboardDirectDictation = true;
    if (originalVersion) Object.defineProperty(Platform, 'Version', originalVersion);
  });

  it('shows the switch on iOS, off by default, and saves it when turned on', () => {
    Platform.OS = 'ios';
    setIOSVersion('26.1');
    render(<PreferencesScreen />);
    expect(screen.getByText('Dictate without opening OpenWhispr')).toBeTruthy();
    expect(
      screen.getByText(
        'Beta. Records in the keyboard for OpenWhispr Cloud, and on this iPhone with Parakeet in Local Mode. Bring Your Own Key, Whisper, a custom cleanup prompt and the assistant still open the app, and so does dictating while music plays or with Bluetooth audio.',
      ),
    ).toBeTruthy();
    const toggle = screen.getByLabelText('Dictate without opening OpenWhispr');
    expect(toggle.props.value).toBe(false);
    fireEvent(toggle, 'valueChange', true);
    expect(mockToggles.keyboardDirectDictation).toHaveBeenCalledWith(true);
  });

  it('keeps the switch hidden after an OTA update to an older native build on iOS 26', () => {
    Platform.OS = 'ios';
    setIOSVersion('26.1');
    AppGroupStorage.supportsKeyboardDirectDictation = false;
    render(<PreferencesScreen />);
    expect(screen.queryByText('Dictate without opening OpenWhispr')).toBeNull();
  });

  it('keeps the containing-app handoff on iOS 18', () => {
    Platform.OS = 'ios';
    setIOSVersion('18.7');
    render(<PreferencesScreen />);
    expect(screen.queryByText('Dictate without opening OpenWhispr')).toBeNull();
  });

  it('is not offered off iOS', () => {
    Platform.OS = 'android';
    render(<PreferencesScreen />);
    expect(screen.queryByText('Dictate without opening OpenWhispr')).toBeNull();
  });
});
