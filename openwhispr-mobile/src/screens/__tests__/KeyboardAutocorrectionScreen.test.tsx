import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockSetEnabled = jest.fn();
const mockSetLanguages = jest.fn();
let mockConfig: Record<string, unknown> | null = null;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/SettingsSwitch', () => {
  const { Switch } = require('react-native');
  return {
    SettingsSwitch: (props: { value: boolean; onValueChange: (next: boolean) => void }) => (
      <Switch testID="autocorrection-switch" {...props} />
    ),
  };
});
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/lib/keyboardAutocorrectionSync', () => ({
  setKeyboardAutocorrectionEnabled: (...args: unknown[]) => mockSetEnabled(...args),
  setKeyboardAutocorrectionLanguages: (...args: unknown[]) => mockSetLanguages(...args),
}));

import KeyboardAutocorrectionScreen from '../KeyboardAutocorrectionScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = null;
});

describe('KeyboardAutocorrectionScreen', () => {
  it('is on with German and English selected by default', () => {
    render(<KeyboardAutocorrectionScreen />);
    expect(screen.getByTestId('autocorrection-switch').props.value).toBe(true);
    expect(screen.getByRole('button', { name: 'German', selected: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'English', selected: true })).toBeTruthy();
  });

  it('switches autocorrection off', () => {
    render(<KeyboardAutocorrectionScreen />);
    fireEvent(screen.getByTestId('autocorrection-switch'), 'valueChange', false);
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
  });

  it('deselects and adds languages', () => {
    render(<KeyboardAutocorrectionScreen />);
    fireEvent.press(screen.getByText('English'));
    expect(mockSetLanguages).toHaveBeenCalledWith(['de']);
  });

  it('keeps the last language selected', () => {
    mockConfig = { defaultMode: 'cloud', keyboardAutocorrectionLanguages: ['de'] };
    render(<KeyboardAutocorrectionScreen />);
    expect(screen.getByText('At least one language stays selected')).toBeTruthy();
    fireEvent.press(screen.getByText('German'));
    expect(mockSetLanguages).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('English'));
    expect(mockSetLanguages).toHaveBeenCalledWith(['de', 'en']);
  });

  it('greys out the languages while autocorrection is off', () => {
    mockConfig = { defaultMode: 'cloud', keyboardAutocorrectionEnabled: false };
    render(<KeyboardAutocorrectionScreen />);
    fireEvent.press(screen.getByText('English'));
    expect(mockSetLanguages).not.toHaveBeenCalled();
  });
});
