import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
  useFocusEffect: () => {},
}));
jest.mock('@/lib/keyboardTranslationSync', () => ({
  keyboardCanTranslate: () => true,
  reconcileKeyboardTranslationFromAppGroup: async () => {},
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: null }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));
jest.mock('@react-native-menu/menu', () =>
  require('../../components/notes/__tests__/menuViewMock'),
);
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { isDictationModeEnabled: () => false, setDictationMode: jest.fn() },
}));

import KeyboardSettingsScreen from '../KeyboardSettingsScreen';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('KeyboardSettingsScreen — hardware keyboard shortcut', () => {
  it('offers the setup guide in the Keyboard section', () => {
    render(<KeyboardSettingsScreen />);
    fireEvent.press(screen.getByText('Hardware keyboard shortcut'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/hardware-keyboard');
  });
});
