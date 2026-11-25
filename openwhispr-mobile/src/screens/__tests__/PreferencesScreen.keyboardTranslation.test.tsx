import React from 'react';
import { render, screen } from '@testing-library/react-native';

const mockCanTranslate = jest.fn(() => true);
const mockReconcile = jest.fn(async () => {});
const mockFocusEffects: Array<() => void> = [];

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (effect: () => void) => {
    mockFocusEffects.push(effect);
  },
}));
jest.mock('@/lib/keyboardTranslationSync', () => ({
  keyboardCanTranslate: () => mockCanTranslate(),
  reconcileKeyboardTranslationFromAppGroup: () => mockReconcile(),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: { keyboardTranslationTarget: 'es' } }),
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

import PreferencesScreen from '../PreferencesScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockCanTranslate.mockReturnValue(true);
  mockFocusEffects.length = 0;
});

describe('PreferencesScreen — Translate dictation', () => {
  it('shows the stored language', () => {
    render(<PreferencesScreen />);
    expect(screen.getByText('Translate dictation')).toBeTruthy();
    expect(screen.getByText('Spanish')).toBeTruthy();
  });

  it('takes a language picked in the keyboard each time the screen shows', () => {
    render(<PreferencesScreen />);
    expect(mockFocusEffects.length).toBeGreaterThan(0);
    mockFocusEffects[mockFocusEffects.length - 1]();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('is hidden on a build whose keyboard predates translation', () => {
    mockCanTranslate.mockReturnValue(false);
    render(<PreferencesScreen />);
    expect(screen.queryByText('Translate dictation')).toBeNull();
  });
});
