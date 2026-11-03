import React from 'react';
import { render } from '@testing-library/react-native';

const mockReplace = jest.fn();
let mockAuthScreenProps: { hideGuestContinue?: boolean } = {};
type MockAuthState = { user: { id: string; isAnonymous: boolean } | null; isGuest: boolean };
let mockAuthState: MockAuthState = { user: null, isGuest: false };
let mockSessionRejected = false;

jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    back: jest.fn(),
    canGoBack: () => false,
  },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: MockAuthState) => unknown) => selector(mockAuthState),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (state: { sessionRejected: boolean }) => unknown) =>
    selector({ sessionRejected: mockSessionRejected }),
}));
jest.mock('@/screens/AuthScreen', () => ({
  __esModule: true,
  default: (props: { hideGuestContinue?: boolean }) => {
    mockAuthScreenProps = props;
    return null;
  },
}));

import AuthRoute from '../auth';

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthScreenProps = {};
  mockSessionRejected = false;
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

  it('keeps reauthentication open until the rejected session is replaced', () => {
    mockAuthState = { user: { id: 'real-user', isAnonymous: false }, isGuest: false };
    mockSessionRejected = true;
    const view = render(<AuthRoute />);

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockAuthScreenProps.hideGuestContinue).toBe(true);
    mockSessionRejected = false;
    view.rerender(<AuthRoute />);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(record)');
  });
});
