import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
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

describe('PreferencesScreen — hardware keyboard shortcut', () => {
  it('offers the setup guide in the Keyboard section', () => {
    render(<PreferencesScreen />);
    fireEvent.press(screen.getByText('Hardware keyboard shortcut'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/hardware-keyboard');
  });
});
