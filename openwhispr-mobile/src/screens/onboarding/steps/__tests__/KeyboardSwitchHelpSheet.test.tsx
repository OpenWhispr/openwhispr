import type React from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { KeyboardSwitchHelpSheet } from '../KeyboardSwitchHelpSheet';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
// The drag rule is covered by useSheetDragToDismiss's own test; the sheet only needs to render.
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('@/hooks/useSheetDragToDismiss', () => ({
  useSheetDragToDismiss: () => ({ dragGesture: {}, sheetStyle: {} }),
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

const renderSheet = (onClose = jest.fn()) =>
  render(<KeyboardSwitchHelpSheet visible onClose={onClose} onDismissed={jest.fn()} />);

beforeEach(() => jest.restoreAllMocks());

it('lists the fixes for the common ways switching gets stuck', () => {
  renderSheet();
  expect(screen.getByText('Can’t switch to OpenWhispr?')).toBeTruthy();
  expect(screen.getByText(/Turn on OpenWhispr in Settings → Keyboards/)).toBeTruthy();
  expect(screen.getByText(/It’s below the letters, bottom left/)).toBeTruthy();
  expect(screen.getByText(/Turn on Allow Full Access in Settings → Keyboards\./)).toBeTruthy();
});

it('opens OpenWhispr’s page in iOS Settings', () => {
  const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  renderSheet();
  fireEvent.press(screen.getByText('Open Settings'));
  expect(openSettings).toHaveBeenCalledTimes(1);
});

// The app can't be used without the keyboard, and debugging it after onboarding is much harder,
// so help never offers a way past the step.
it('offers no way past the step', () => {
  renderSheet();
  expect(screen.queryByText(/Continue/)).toBeNull();
  expect(screen.queryByText(/later/i)).toBeNull();
});

it('closes', () => {
  const onClose = jest.fn();
  renderSheet(onClose);
  fireEvent.press(screen.getByText('Close'));
  expect(onClose).toHaveBeenCalledTimes(1);
});
