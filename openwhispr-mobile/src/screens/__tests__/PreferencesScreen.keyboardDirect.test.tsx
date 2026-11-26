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
import PreferencesScreen from '../PreferencesScreen';

describe('PreferencesScreen — dictate without opening the app', () => {
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
    render(<PreferencesScreen />);
    expect(screen.getByText('Dictate without opening OpenWhispr')).toBeTruthy();
    expect(
      screen.getByText('Beta. Records in the keyboard instead of switching to the app.'),
    ).toBeTruthy();
    const toggle = screen.getByLabelText('Dictate without opening OpenWhispr');
    expect(toggle.props.value).toBe(true);
    fireEvent(toggle, 'valueChange', false);
    expect(mockToggles.keyboardDirectDictation).toHaveBeenCalledWith(false);
  });

  it('stays off for someone who turned it off', () => {
    mockConfig = { defaultMode: 'cloud', keyboardDirectDictation: false };
    render(<PreferencesScreen />);
    expect(screen.getByLabelText('Dictate without opening OpenWhispr').props.value).toBe(false);
  });

  it('explains when the app still opens behind the help button', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<PreferencesScreen />);
    fireEvent.press(screen.getByLabelText('When OpenWhispr still opens'));
    expect(alert).toHaveBeenCalledWith(
      'When OpenWhispr still opens',
      expect.stringContaining('Bring Your Own Key, Whisper, a custom cleanup prompt'),
    );
  });

  it('keeps the switch hidden after an OTA update to an older native build on iOS 26', () => {
    AppGroupStorage.supportsKeyboardDirectDictation = false;
    render(<PreferencesScreen />);
    expect(screen.queryByText('Dictate without opening OpenWhispr')).toBeNull();
  });

  it('keeps the containing-app handoff on iOS 18', () => {
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

describe('PreferencesScreen — keyboard sections', () => {
  it('groups setup, dictation and typing under their own headings', () => {
    Platform.OS = 'ios';
    render(<PreferencesScreen />);
    expect(screen.getByText('Keyboard setup')).toBeTruthy();
    expect(screen.getByText('Keyboard dictation')).toBeTruthy();
    expect(screen.getByText('Keyboard typing')).toBeTruthy();
  });
});
