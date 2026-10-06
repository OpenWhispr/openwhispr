import type React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { OnboardingError } from '@/lib/onboardingErrors';
import { SlowDownloadSheet } from '../SlowDownloadSheet';
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
}));
const mockDrag = jest.fn((_visible: boolean, _onClose: () => void) => ({
  dragGesture: {},
  sheetStyle: {},
}));
jest.mock('@/hooks/useSheetDragToDismiss', () => ({
  useSheetDragToDismiss: (visible: boolean, onClose: () => void) => mockDrag(visible, onClose),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

it('shows a Cloud failure without losing the ability to keep downloading locally', async () => {
  const onContinueCloud = jest
    .fn()
    .mockRejectedValue(new OnboardingError('Cloud needs a connection'));
  const onKeepWaiting = jest.fn();
  const screen = render(
    <SlowDownloadSheet visible onContinueCloud={onContinueCloud} onKeepWaiting={onKeepWaiting} />,
  );
  fireEvent.press(screen.getByText('Continue with Cloud for now'));
  expect(await screen.findByText('Cloud needs a connection')).toBeTruthy();
  fireEvent.press(screen.getByText('Keep waiting'));
  expect(onKeepWaiting).toHaveBeenCalledTimes(1);
});
it('does not start two Cloud transitions on repeated taps', async () => {
  const onContinueCloud = jest.fn().mockReturnValue(new Promise<void>(() => undefined));
  const screen = render(
    <SlowDownloadSheet visible onContinueCloud={onContinueCloud} onKeepWaiting={jest.fn()} />,
  );
  const button = screen.getByText('Continue with Cloud for now');
  fireEvent.press(button);
  fireEvent.press(button);
  await waitFor(() => expect(onContinueCloud).toHaveBeenCalledTimes(1));
});
it('does not show the text of an unexpected Cloud failure', async () => {
  const onContinueCloud = jest
    .fn()
    .mockRejectedValue(new Error("Calling the 'setValueWithKeyAsync' function has failed"));
  const screen = render(
    <SlowDownloadSheet visible onContinueCloud={onContinueCloud} onKeepWaiting={jest.fn()} />,
  );
  fireEvent.press(screen.getByText('Continue with Cloud for now'));
  expect(await screen.findByText('Cloud is unavailable. Try again.')).toBeTruthy();
  expect(screen.queryByText(/setValueWithKeyAsync/)).toBeNull();
});

it('treats pulling the sheet down as keep waiting', () => {
  const onKeepWaiting = jest.fn();
  render(<SlowDownloadSheet visible onContinueCloud={jest.fn()} onKeepWaiting={onKeepWaiting} />);
  const pulledDown = mockDrag.mock.calls.at(-1)![1];
  act(() => pulledDown());
  expect(onKeepWaiting).toHaveBeenCalledTimes(1);
});
