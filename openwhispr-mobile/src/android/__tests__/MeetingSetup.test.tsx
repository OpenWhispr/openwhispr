import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { MeetingSetup } from '../MeetingSetup';
let mockOnDevice = true;
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (select: (state: unknown) => unknown) => select({ user: null }),
}));
jest.mock('../meetingRouting', () => ({ meetingOnDevice: () => mockOnDevice }));
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: () => true }));
jest.mock('../ui', () => {
  const { View, Pressable, Text } = require('react-native');
  return {
    Card: View,
    useUiStyles: () => ({}),
    Button: ({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }) =>
      require('react').createElement(
        Pressable,
        { onPress, disabled: busy },
        require('react').createElement(Text, null, label),
      ),
  };
});
it('offers Start without an account when meetings run on the phone, and keeps model settings', () => {
  mockOnDevice = true;
  const start = jest.fn();
  const view = render(<MeetingSetup onStart={start} busy={false} />);
  fireEvent.press(view.getByText('meetingStart'));
  expect(start).toHaveBeenCalledTimes(1);
  expect(view.getByText('models')).toBeTruthy();
  expect(view.queryByText('signIn')).toBeNull();
});
it('keeps the sign-in requirement for live meetings on Cloud', () => {
  mockOnDevice = false;
  const view = render(<MeetingSetup onStart={jest.fn()} busy={false} />);
  expect(view.getByText('signIn')).toBeTruthy();
  expect(view.queryByText('meetingStart')).toBeNull();
});
it('starts by itself after mount when opened from the Notes Start sheet', () => {
  jest.useFakeTimers();
  mockOnDevice = true;
  const start = jest.fn();
  const view = render(<MeetingSetup onStart={start} busy={false} autoStart />);
  expect(start).not.toHaveBeenCalled();
  jest.advanceTimersByTime(50);
  expect(start).toHaveBeenCalledTimes(1);
  view.rerender(<MeetingSetup onStart={start} busy={false} autoStart />);
  jest.advanceTimersByTime(2000);
  expect(start).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
it('waits for the picked calendar event, but never longer than 1.5 s', () => {
  jest.useFakeTimers();
  mockOnDevice = true;
  const start = jest.fn();
  render(<MeetingSetup onStart={start} busy={false} autoStart ready={false} />);
  jest.advanceTimersByTime(1400);
  expect(start).not.toHaveBeenCalled();
  jest.advanceTimersByTime(100);
  expect(start).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
