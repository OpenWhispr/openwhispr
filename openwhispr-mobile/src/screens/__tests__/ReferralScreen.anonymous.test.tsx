import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';

const mockSignOut = jest.fn();
const mockPush = jest.fn();
const mockFetchReferralStats = jest.fn();
const mockSendInvite = jest.fn();

type MockAuthState = {
  user: { id: string; email: string; isAnonymous: boolean } | null;
  sessionCookie: string | null;
  signOut: jest.Mock;
};
let mockAuthState: MockAuthState = {
  user: { id: 'anon-user', email: 'temp-1@anon.openwhispr.invalid', isAnonymous: true },
  sessionCookie: 'session=anon',
  signOut: mockSignOut,
};
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector?: (state: MockAuthState) => unknown) =>
    selector ? selector(mockAuthState) : mockAuthState,
}));
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/lib/referralApi', () => ({
  fetchReferralStats: (...args: unknown[]) => mockFetchReferralStats(...args),
  fetchReferralInvites: jest.fn().mockResolvedValue([]),
  sendReferralInvite: (...args: unknown[]) => mockSendInvite(...args),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn(), isValidEmail: () => true }));
jest.mock('@/config/colors', () => ({ iosColor: () => '#999' }));
jest.mock('@/lib/fonts', () => ({ AppFont: {} }));
jest.mock('@/lib/accountAccess', () => ({
  ...jest.requireActual('@/lib/accountRequiredError'),
  handleAccountRequiredError: jest.fn(() => false),
  requiresRealAccount: jest.requireActual('@/lib/accountAccess').requiresRealAccount,
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/TabScreenHeader', () => ({ TabScreenHeader: () => null }));
jest.mock('@/components/ui/GlassBackButton', () => ({ GlassBackButton: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));
jest.mock('@/components/ui/Button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: ({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) => (
      <Pressable onPress={onPress}>
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});

describe('signed-in referral actions', () => {
  beforeEach(() => {
    mockAuthState = {
      user: { id: 'member', email: 'member@example.com', isAnonymous: false },
      sessionCookie: 'session=member',
      signOut: mockSignOut,
    };
    mockFetchReferralStats.mockResolvedValue({
      referralCode: 'test',
      referralLink: 'https://openwhispr.com/r/test',
      totalReferrals: 0,
      completedReferrals: 0,
      totalMonthsEarned: 0,
      referrals: [],
    });
  });
  it('unlocks a rejected invite and preserves the address for retry', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockSendInvite.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(false);
    const screen = render(<ReferralScreen />);
    const input = await screen.findByPlaceholderText('friend@example.com');
    fireEvent.changeText(input, 'friend@example.com');
    fireEvent.press(screen.getByText('Send'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Failed', expect.any(String)));
    expect(screen.getByPlaceholderText('friend@example.com').props.editable).toBe(true);
    expect(screen.getByPlaceholderText('friend@example.com').props.value).toBe(
      'friend@example.com',
    );
    fireEvent.press(screen.getByText('Send'));
    await waitFor(() => expect(mockSendInvite).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Send')).toBeTruthy());
    alert.mockRestore();
  });
  it('shares only the server-provided referral link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction });
    const screen = render(<ReferralScreen />);
    fireEvent.press(await screen.findByText('Share referral link'));
    expect(share).toHaveBeenCalledWith({ message: 'https://openwhispr.com/r/test' });
    expect(mockSendInvite).not.toHaveBeenCalled();
    share.mockRestore();
  });
});

import ReferralScreen from '@/screens/ReferralScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState = {
    user: { id: 'anon-user', email: 'temp-1@anon.openwhispr.invalid', isAnonymous: true },
    sessionCookie: 'session=anon',
    signOut: mockSignOut,
  };
});

// Referrals are account-gated on the API. An anonymous onboarding session has
// a user object, but it must land on the same empty state a guest sees rather
// than load stats the server refuses.
describe('ReferralScreen with an anonymous session', () => {
  it('shows the guest state instead of loading account-gated stats', () => {
    const { getByText } = render(<ReferralScreen />);

    expect(getByText('Give a month, get a month')).toBeTruthy();
    expect(mockFetchReferralStats).not.toHaveBeenCalled();
  });

  // The guest CTA signs out to reach AuthScreen. Signing an anonymous session
  // out would revoke it — and with it the purchase and notes it carries.
  it('sends the user to create an account without revoking the session', () => {
    const { getByText } = render(<ReferralScreen />);

    fireEvent.press(getByText('Create an account to get your link'));

    expect(mockPush).toHaveBeenCalledWith('/auth');
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('still signs a guest out to reach the sign-in screen', () => {
    mockAuthState = { user: null, sessionCookie: null, signOut: mockSignOut };
    const { getByText } = render(<ReferralScreen />);

    fireEvent.press(getByText('Sign in to get your link'));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
