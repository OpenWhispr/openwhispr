import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState.user = {
    id: 'anon-user',
    email: 'temp-1@anon.openwhispr.invalid',
    isAnonymous: true,
  };
  mockAuthState.isGuest = false;
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
