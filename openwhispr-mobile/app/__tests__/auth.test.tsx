import React from 'react';
import { render } from '@testing-library/react-native';

const mockReplace = jest.fn();
let mockAuthScreenProps: {
  hideGuestContinue?: boolean;
  signInAgainEmail?: string;
  reason?: string;
} = {};
type MockAuthState = {
  user: { id: string; email?: string; isAnonymous: boolean } | null;
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
jest.mock('@/screens/AuthScreen', () => mockAuthScreenModule());
jest.mock('@/screens/AuthScreen.android', () => mockAuthScreenModule());

import AuthRoute from '../auth';
import AndroidAuthRoute from '../auth.android';

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthScreenProps = {};
  mockSessionRejected = false;
  mockParams = {};
});

describe('/auth route', () => {
  // The only way an anonymous session gets a real account is through this
  // modal, so it must not bounce them to Home the way a signed-in user is.
  it('stays open for an anonymous session', () => {
    mockAuthState = { user: { id: 'anon-user', isAnonymous: true }, isGuest: false };

    render(<AuthRoute />);

    expect(mockReplace).not.toHaveBeenCalled();
    // Guest continue would clear the session they are here to upgrade.
    expect(mockAuthScreenProps.hideGuestContinue).toBe(true);
  });

  it('redirects a signed-in user to Home', () => {
    mockAuthState = { user: { id: 'real-user', isAnonymous: false }, isGuest: false };

    render(<AuthRoute />);

    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(record)');
  });

  it('retains the upstream iOS redirect when Android marks a cloud session rejected', () => {
    mockAuthState = { user: { id: 'real-user', isAnonymous: false }, isGuest: false };
    mockSessionRejected = true;

    render(<AuthRoute />);

    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(record)');
  });

  it('keeps reauthentication open until the rejected session is replaced', () => {
    mockAuthState = {
      user: { id: 'real-user', email: 'alex@example.com', isAnonymous: false },
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
});
