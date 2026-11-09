import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockSetLayout = jest.fn();
let mockConfig: { keyboardLetterLayout?: string } | null = null;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/lib/keyboardLayoutSync', () => ({
  setKeyboardLetterLayout: (layout: string) => mockSetLayout(layout),
}));

import KeyboardLayoutScreen from '../KeyboardLayoutScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = null;
});

describe('KeyboardLayoutScreen', () => {
  it('lists English, German and Swiss French', () => {
    render(<KeyboardLayoutScreen />);
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText('German')).toBeTruthy();
    expect(screen.getByText('Swiss French')).toBeTruthy();
    expect(screen.getByText('QWERTZ with è, é and à')).toBeTruthy();
  });

  it('saves the layout the user picks', () => {
    render(<KeyboardLayoutScreen />);
    fireEvent.press(screen.getByText('Swiss French'));
    expect(mockSetLayout).toHaveBeenCalledWith('fr_CH');
  });
});
