import React from 'react';
import { Alert, Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockToggles: Record<string, jest.Mock> = {};
let mockConfig: Record<string, unknown> | null = null;

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: () => {} }));
jest.mock('@/lib/keyboardTranslationSync', () => ({
  keyboardCanTranslate: () => true,
  reconcileKeyboardTranslationFromAppGroup: async () => {},
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
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
import KeyboardSettingsScreen from '../KeyboardSettingsScreen';

describe('KeyboardSettingsScreen — dictate without opening the app', () => {
  const originalOS = Platform.OS;
  const originalVersion = Object.getOwnPropertyDescriptor(Platform, 'Version');
  function setIOSVersion(version: string): void {
    Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
  }
  beforeEach(() => {
    Platform.OS = 'ios';
    setIOSVersion('26.1');
  });
  afterEach(() => {
    Platform.OS = originalOS;
    AppGroupStorage.supportsKeyboardDirectDictation = true;
    mockConfig = null;
    Object.values(mockToggles).forEach((toggle) => toggle.mockClear());
    jest.restoreAllMocks();
    if (originalVersion) Object.defineProperty(Platform, 'Version', originalVersion);
  });

  it('shows the switch on iOS, on by default, and saves it when turned off', () => {
    render(<KeyboardSettingsScreen />);
    expect(screen.getByText('Dictate in place')).toBeTruthy();
    expect(
      screen.getByText('Beta. Records in the keyboard instead of switching to the app.'),
    ).toBeTruthy();
    const toggle = screen.getByLabelText('Dictate in place');
    expect(toggle.props.value).toBe(true);
    fireEvent(toggle, 'valueChange', false);
    expect(mockToggles.keyboardDirectDictation).toHaveBeenCalledWith(false);
  });

  it('stays off for someone who turned it off', () => {
    mockConfig = { defaultMode: 'cloud', keyboardDirectDictation: false };
    render(<KeyboardSettingsScreen />);
    expect(screen.getByLabelText('Dictate in place').props.value).toBe(false);
  });

  it('explains when the app still opens behind the help button', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<KeyboardSettingsScreen />);
    fireEvent.press(screen.getByLabelText('When OpenWhispr still opens'));
    expect(alert).toHaveBeenCalledWith(
      'When OpenWhispr still opens',
      expect.stringContaining('Bring Your Own Key, Whisper, a custom cleanup prompt'),
    );
  });

  it('keeps the switch hidden after an OTA update to an older native build on iOS 26', () => {
    AppGroupStorage.supportsKeyboardDirectDictation = false;
    render(<KeyboardSettingsScreen />);
    expect(screen.queryByText('Dictate in place')).toBeNull();
  });

  it('keeps the containing-app handoff on iOS 18', () => {
    setIOSVersion('18.7');
    render(<KeyboardSettingsScreen />);
    expect(screen.queryByText('Dictate in place')).toBeNull();
  });

  it('is not offered off iOS', () => {
    Platform.OS = 'android';
    render(<KeyboardSettingsScreen />);
    expect(screen.queryByText('Dictate in place')).toBeNull();
  });
});

describe('KeyboardSettingsScreen — keyboard sections', () => {
  it('groups setup, dictation and typing under their own headings', () => {
    Platform.OS = 'ios';
    render(<KeyboardSettingsScreen />);
    expect(screen.getByText('Setup')).toBeTruthy();
    expect(screen.getByText('Dictation')).toBeTruthy();
    expect(screen.getByText('Typing')).toBeTruthy();
  });
});
