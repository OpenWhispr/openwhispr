import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
// nativewind's cssInterop breaks jest's transform; same stub the other settings suites use.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: null }),
}));
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => jest.fn() }));

import PreferencesScreen from '../PreferencesScreen';

beforeEach(() => {
  mockRouterPush.mockClear();
});

describe('PreferencesScreen — keyboard entry', () => {
  it('keeps the keyboard settings behind one Keyboard row', () => {
    render(<PreferencesScreen />);
    expect(screen.getByText('Keyboard')).toBeTruthy();
    expect(screen.getByText('Setup, dictation and typing')).toBeTruthy();
    expect(screen.queryByText('Full Access')).toBeNull();
    expect(screen.queryByText('Dictate in place')).toBeNull();
    expect(screen.queryByText('Typing language')).toBeNull();
  });

  it('opens the Keyboard screen', () => {
    render(<PreferencesScreen />);
    fireEvent.press(screen.getByText('Keyboard'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/keyboard');
  });
});
