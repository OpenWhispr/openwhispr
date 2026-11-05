import React from 'react';
import { render } from '@testing-library/react-native';
import { MeetingRecordScreen } from '@/screens/MeetingRecordScreen.android';

type MockUser = { id: string; isAnonymous: boolean } | null;
let mockUser: MockUser = null;
let mockMode: 'private' | 'cloud' = 'private';
const mockLocalUnmount = jest.fn();
const mockCloudUnmount = jest.fn();

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (select: (state: { user: MockUser }) => unknown) => select({ user: mockUser }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (select: (state: { activeMode: typeof mockMode }) => unknown) =>
    select({ activeMode: mockMode }),
}));
jest.mock('expo-router', () => ({ router: {} }));
jest.mock('@/lib/androidCopy', () => ({
  androidCopy: (_key: string, fallback: string) => fallback,
}));
jest.mock('@/android/CloudMeetingScreen', () => ({
  CloudMeetingScreen: function CloudScreen() {
    require('react').useEffect(() => () => mockCloudUnmount(), []);
    return require('react').createElement(
      require('react-native').Text,
      { testID: 'cloud' },
      'Cloud',
    );
  },
}));
jest.mock('@/android/MeetingRecordScreen', () => ({
  MeetingRecordScreen: function LocalScreen() {
    require('react').useEffect(() => () => mockLocalUnmount(), []);
    return require('react').createElement(
      require('react-native').Text,
      { testID: 'android-local' },
      'Local',
    );
  },
}));
jest.mock('@/screens/MeetingRecordScreen.tsx', () => ({
  MeetingRecordScreen: () =>
    require('react').createElement(require('react-native').Text, { testID: 'ios-default' }, 'iOS'),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = null;
  mockMode = 'private';
});

it.each([
  { name: 'signed-in Local mode', user: { id: 'owner', isAnonymous: false }, mode: 'private' },
  { name: 'signed-out Local mode', user: null, mode: 'private' },
  { name: 'signed-out Cloud mode', user: null, mode: 'cloud' },
  { name: 'anonymous Cloud mode', user: { id: 'guest', isAnonymous: true }, mode: 'cloud' },
] as const)('uses the retained Android Local screen for $name', ({ user, mode }) => {
  mockUser = user;
  mockMode = mode;
  const view = render(<MeetingRecordScreen />);
  expect(view.getByTestId('android-local')).toBeTruthy();
  expect(view.queryByTestId('ios-default')).toBeNull();
  expect(view.queryByTestId('cloud')).toBeNull();
});

it('uses the reviewed Cloud screen for a signed-in Cloud meeting', () => {
  mockUser = { id: 'owner', isAnonymous: false };
  mockMode = 'cloud';
  const view = render(<MeetingRecordScreen />);
  expect(view.getByTestId('cloud')).toBeTruthy();
  expect(view.queryByTestId('android-local')).toBeNull();
  expect(view.queryByTestId('ios-default')).toBeNull();
});

it('unmounts each active screen when its account or mode no longer selects it', () => {
  mockUser = { id: 'owner', isAnonymous: false };
  const view = render(<MeetingRecordScreen />);
  mockMode = 'cloud';
  view.rerender(<MeetingRecordScreen />);
  expect(view.getByTestId('cloud')).toBeTruthy();
  expect(mockLocalUnmount).toHaveBeenCalledTimes(1);

  mockUser = null;
  view.rerender(<MeetingRecordScreen />);
  expect(view.getByTestId('android-local')).toBeTruthy();
  expect(mockCloudUnmount).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId('ios-default')).toBeNull();
});
