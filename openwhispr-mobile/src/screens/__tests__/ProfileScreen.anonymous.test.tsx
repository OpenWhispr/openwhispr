import React from 'react';
import { Platform } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { confirmDestructive } from '@/lib/alerts';

const mockRouterPush = jest.fn();
const mockSignOut = jest.fn();
const mockDeleteAccount = jest.fn();
type MockAuthState = {
  user: { id: string; email: string; name?: string; isAnonymous: boolean } | null;
  isGuest: boolean;
  signOut: jest.Mock;
  deleteAccount: jest.Mock;
};
const mockAuthState: MockAuthState = {
  user: { id: 'anon-user', email: 'temp-1@anon.openwhispr.invalid', isAnonymous: true },
  isGuest: false,
  signOut: mockSignOut,
  deleteAccount: mockDeleteAccount,
};

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(() => mockAuthState, { getState: () => mockAuthState }),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (state: { usage: null; load: jest.Mock }) => unknown) =>
    selector({ usage: null, load: jest.fn() }),
}));
jest.mock('@/lib/alerts', () => ({
  confirmAccountDeletion: jest.fn(),
  confirmDestructive: jest.fn(),
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/PlanBadge', () => ({ PlanBadge: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));
jest.mock('@/components/ui/SettingsScreen', () => ({
  SettingsScreen: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));
jest.mock('@/components/ui/SettingsSection', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) => (
      <Pressable onPress={onPress}>
        <Text>{title}</Text>
      </Pressable>
    ),
    SettingsSection: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});

import ProfileScreen from '../ProfileScreen';

const originalPlatform = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
  mockAuthState.user = {
    id: 'anon-user',
    email: 'temp-1@anon.openwhispr.invalid',
    isAnonymous: true,
  };
  mockAuthState.isGuest = false;
});

afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

describe('ProfileScreen sign-in navigation', () => {
  it.each([false, true])('opens auth on Android when signed out (guest=%s)', (isGuest) => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockAuthState.user = null;
    mockAuthState.isGuest = isGuest;

    const { getByText } = render(<ProfileScreen />);
    fireEvent.press(getByText('Sign In'));

    expect(mockRouterPush).toHaveBeenCalledWith('/auth');
    expect(confirmDestructive).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'] as const)(
    'still confirms a real account sign-out on %s',
    async (platform) => {
      Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
      mockAuthState.user = { id: 'real', email: 'real@example.com', isAnonymous: false };

      const { getByText } = render(<ProfileScreen />);
      fireEvent.press(getByText('Sign Out'));

      expect(mockSignOut).not.toHaveBeenCalled();
      expect(confirmDestructive).toHaveBeenCalledWith(
        'Sign Out',
        expect.any(String),
        expect.any(Function),
        { destructiveLabel: 'Sign Out' },
      );
      await act(async () => {
        await jest.mocked(confirmDestructive).mock.calls[0][2]();
      });
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(mockRouterPush).not.toHaveBeenCalled();
    },
  );

  it('preserves the iOS guest-exit flow handled by its root auth gate', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    mockAuthState.user = null;
    mockAuthState.isGuest = true;

    const { getByText } = render(<ProfileScreen />);
    fireEvent.press(getByText('Sign In'));

    expect(confirmDestructive).toHaveBeenCalledWith(
      'Leave Guest Mode',
      expect.any(String),
      expect.any(Function),
      { destructiveLabel: 'Continue' },
    );
    await act(async () => {
      await jest.mocked(confirmDestructive).mock.calls[0][2]();
    });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

describe('ProfileScreen with an anonymous session', () => {
  it('offers account creation instead of sign-out or deletion', () => {
    const { getByText, queryByText } = render(<ProfileScreen />);

    fireEvent.press(getByText('Create Account'));

    expect(mockRouterPush).toHaveBeenCalledWith('/auth');
    expect(queryByText('Sign Out')).toBeNull();
    expect(queryByText('Delete Account')).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('keeps sign-out and deletion for a real account', () => {
    mockAuthState.user = {
      id: 'real',
      email: 'real@example.com',
      name: 'Real',
      isAnonymous: false,
    };

    const { getByText, queryByText } = render(<ProfileScreen />);

    expect(getByText('Sign Out')).toBeTruthy();
    expect(getByText('Delete Account')).toBeTruthy();
    expect(queryByText('Create Account')).toBeNull();
  });
});
