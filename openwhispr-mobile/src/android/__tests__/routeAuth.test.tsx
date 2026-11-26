import React from 'react';
import { render } from '@testing-library/react-native';

const mockReplace = jest.fn();
let mockAuthScreenProps: {
  hideGuestContinue?: boolean;
  signInAgainEmail?: string;
  reason?: string;
} = {};
type MockAuthState = {
  user: { id: string; email?: string; isAnonymous: boolean; emailVerified?: boolean } | null;
  isGuest: boolean;
};
let mockAuthState: MockAuthState = { user: null, isGuest: false };
let mockSessionRejected = false;
let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    back: jest.fn(),
    canGoBack: () => false,
  },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: MockAuthState) => unknown) => selector(mockAuthState),
}));
jest.mock('@/store/useUsageStore.android', () => ({
  useUsageStore: (selector: (state: { sessionRejected: boolean }) => unknown) =>
    selector({ sessionRejected: mockSessionRejected }),
}));
function mockAuthScreenModule() {
  return {
    __esModule: true,
    default: (props: typeof mockAuthScreenProps) => {
      mockAuthScreenProps = props;
      return null;
    },
    isAuthReason: (value: unknown) => value === 'sync',
  };
}
jest.mock('@/screens/AuthScreen.android', () => mockAuthScreenModule());

import AndroidAuthRoute from '../../../app-android/auth';

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthScreenProps = {};
  mockSessionRejected = false;
  mockParams = {};
});

describe('Android /auth route', () => {
  it('keeps reauthentication open until the rejected session is replaced', () => {
    mockAuthState = {
      user: { id: 'real-user', email: 'alex@example.com', isAnonymous: false, emailVerified: true },
      isGuest: false,
    };
    mockSessionRejected = true;
    const view = render(<AndroidAuthRoute />);

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockAuthScreenProps.hideGuestContinue).toBe(true);
    // Sign in again as the same account (2.5); its notes stay with it.
    expect(mockAuthScreenProps.signInAgainEmail).toBe('alex@example.com');
    mockSessionRejected = false;
    view.rerender(<AndroidAuthRoute />);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(record)');
  });

  it('passes a known sign-in reason and drops anything else', () => {
    mockAuthState = { user: null, isGuest: false };
    mockParams = { reason: 'sync' };
    const view = render(<AndroidAuthRoute />);
    expect(mockAuthScreenProps.reason).toBe('sync');
    expect(mockAuthScreenProps.signInAgainEmail).toBeUndefined();
    mockParams = { reason: 'nonsense' };
    view.rerender(<AndroidAuthRoute />);
    expect(mockAuthScreenProps.reason).toBeUndefined();
  });

  it('keeps an email account that has not verified on Verify your email (decision 12)', () => {
    mockAuthState = {
      user: { id: 'new-user', email: 'alex@example.com', isAnonymous: false, emailVerified: false },
      isGuest: false,
    };
    const view = render(<AndroidAuthRoute />);
    expect(mockReplace).not.toHaveBeenCalled();
    mockAuthState = {
      user: { id: 'new-user', email: 'alex@example.com', isAnonymous: false, emailVerified: true },
      isGuest: false,
    };
    view.rerender(<AndroidAuthRoute />);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(record)');
  });
});
