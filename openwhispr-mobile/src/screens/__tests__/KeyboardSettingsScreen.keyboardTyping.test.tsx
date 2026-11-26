import React from 'react';
import { Alert, Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { UserConfig } from '@/types';

const mockAppGroup: Record<string, string> = {};
const mockUpdateConfig = jest.fn(async (_updates: Partial<UserConfig>) => {});
let mockConfig: UserConfig | null = null;

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: () => {} }));
jest.mock('@/lib/keyboardTranslationSync', () => ({
  keyboardCanTranslate: () => true,
  reconcileKeyboardTranslationFromAppGroup: async () => {},
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@react-native-menu/menu', () =>
  require('../../components/notes/__tests__/menuViewMock'),
);
jest.mock('@/store/useConfigStore', () => {
  const state = (): unknown => ({ config: mockConfig, updateConfig: mockUpdateConfig });
  return {
    useConfigStore: Object.assign((selector: (value: unknown) => unknown) => selector(state()), {
      getState: state,
    }),
  };
});
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => mockAppGroup[key] ?? null,
    setItem: (key: string, value: string) => {
      mockAppGroup[key] = value;
      return true;
    },
    removeItem: (key: string) => {
      delete mockAppGroup[key];
      return true;
    },
  },
}));

import KeyboardSettingsScreen from '../KeyboardSettingsScreen';

describe('KeyboardSettingsScreen — keyboard typing', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'ios';
    mockConfig = null;
    mockUpdateConfig.mockClear();
    for (const key of Object.keys(mockAppGroup)) delete mockAppGroup[key];
  });
  afterEach(() => {
    Platform.OS = originalOS;
    jest.restoreAllMocks();
  });

  it('defaults to Automatic for language and layout, with haptics on', () => {
    render(<KeyboardSettingsScreen />);
    expect(screen.getByLabelText('Typing language: Automatic')).toBeTruthy();
    expect(screen.getByLabelText('Layout: Automatic')).toBeTruthy();
    expect(screen.getByLabelText('Haptic feedback').props.value).toBe(true);
    expect(screen.getByText('A light tap on every key')).toBeTruthy();
  });

  it('shows the saved choices', () => {
    mockConfig = {
      defaultMode: 'cloud',
      keyboardTypingLanguage: 'de',
      keyboardTypingLayout: 'qwerty',
      keyboardHapticsEnabled: false,
    };
    render(<KeyboardSettingsScreen />);
    expect(screen.getByLabelText('Typing language: Deutsch')).toBeTruthy();
    expect(screen.getByLabelText('Layout: QWERTY')).toBeTruthy();
    expect(screen.getByLabelText('Haptic feedback').props.value).toBe(false);
  });

  it.each([
    ['menu-en', 'en'],
    ['menu-de', 'de'],
  ] as const)('writes the typing language picked with %s', (testID, language) => {
    render(<KeyboardSettingsScreen />);
    fireEvent.press(screen.getByTestId(testID));
    expect(mockAppGroup.keyboard_typing_language).toBe(language);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ keyboardTypingLanguage: language });
  });

  it.each([
    ['menu-qwerty', 'qwerty'],
    ['menu-qwertz', 'qwertz'],
  ] as const)('writes the layout picked with %s', (testID, layout) => {
    render(<KeyboardSettingsScreen />);
    fireEvent.press(screen.getByTestId(testID));
    expect(mockAppGroup.keyboard_typing_layout).toBe(layout);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ keyboardTypingLayout: layout });
  });

  it('removes the keys when Automatic is picked', () => {
    mockConfig = {
      defaultMode: 'cloud',
      keyboardTypingLanguage: 'de',
      keyboardTypingLayout: 'qwertz',
    };
    mockAppGroup.keyboard_typing_language = 'de';
    mockAppGroup.keyboard_typing_layout = 'qwertz';
    render(<KeyboardSettingsScreen />);
    const [languageAutomatic, layoutAutomatic] = screen.getAllByTestId('menu-automatic');

    fireEvent.press(languageAutomatic);
    expect('keyboard_typing_language' in mockAppGroup).toBe(false);
    expect(mockAppGroup.keyboard_typing_layout).toBe('qwertz');
    expect(mockUpdateConfig).toHaveBeenCalledWith({ keyboardTypingLanguage: null });

    fireEvent.press(layoutAutomatic);
    expect('keyboard_typing_layout' in mockAppGroup).toBe(false);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ keyboardTypingLayout: null });
  });

  it('writes haptics as "0" and "1"', () => {
    render(<KeyboardSettingsScreen />);
    const toggle = screen.getByLabelText('Haptic feedback');
    fireEvent(toggle, 'valueChange', false);
    expect(mockAppGroup.keyboard_haptics_enabled).toBe('0');
    expect(mockUpdateConfig).toHaveBeenCalledWith({ keyboardHapticsEnabled: false });
    fireEvent(toggle, 'valueChange', true);
    expect(mockAppGroup.keyboard_haptics_enabled).toBe('1');
    expect(mockUpdateConfig).toHaveBeenCalledWith({ keyboardHapticsEnabled: true });
  });

  it('clears learned words only after confirming', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Date, 'now').mockReturnValue(1790000000000);
    render(<KeyboardSettingsScreen />);
    fireEvent.press(screen.getByText('Clear learned words'));

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe('Clear learned words?');
    expect(message).toBe('The keyboard forgets the words it has learned from your typing.');
    expect('keyboard_learned_words_cleared_at_ms' in mockAppGroup).toBe(false);

    buttons?.find((button) => button.text === 'Cancel')?.onPress?.();
    expect('keyboard_learned_words_cleared_at_ms' in mockAppGroup).toBe(false);

    buttons?.find((button) => button.text === 'Clear')?.onPress?.();
    expect(mockAppGroup.keyboard_learned_words_cleared_at_ms).toBe('1790000000000');
  });

  it('is not offered off iOS', () => {
    Platform.OS = 'android';
    render(<KeyboardSettingsScreen />);
    expect(screen.queryByText('Typing language')).toBeNull();
    expect(screen.queryByText('Clear learned words')).toBeNull();
  });
});
