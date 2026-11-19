import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
});

type MockAuth = {
  user: { id: string; email: string; isAnonymous: boolean } | null;
  isLoading: boolean;
  loadingProvider: 'google' | 'microsoft' | null;
  error: string | null;
  signIn: jest.Mock;
  signUp: jest.Mock;
  signInWithGoogle: jest.Mock;
  signInWithMicrosoft: jest.Mock;
  continueAsGuest: jest.Mock;
  clearError: jest.Mock;
};
let mockAuth: MockAuth;
const mockListeners = new Set<() => void>();
function mockSetAuth(patch: Partial<MockAuth>) {
  mockAuth = { ...mockAuth, ...patch };
  mockListeners.forEach((listener) => listener());
}
jest.mock('@/store/useAuthStore', () => {
  const { useSyncExternalStore } = require('react');
  const useMockAuthStore = (selector?: (state: MockAuth) => unknown) => {
    const state = useSyncExternalStore(
      (listener: () => void) => {
        mockListeners.add(listener);
        return () => mockListeners.delete(listener);
      },
      () => mockAuth,
    );
    return selector ? selector(state) : state;
  };
  useMockAuthStore.getState = () => mockAuth;
  useMockAuthStore.setState = (patch: Partial<MockAuth>) => mockSetAuth(patch);
  return { useAuthStore: useMockAuthStore };
});
const mockCheckUser = jest.fn();
jest.mock('@/lib/authClient', () => ({ checkUserExists: (email: string) => mockCheckUser(email) }));
const mockRequestReset = jest.fn();
const mockResetPassword = jest.fn();
jest.mock('@/lib/authClient.android', () => ({
  requestPasswordResetEmail: (...args: unknown[]) => mockRequestReset(...args),
  resetPasswordWithToken: (...args: unknown[]) => mockResetPassword(...args),
}));
const mockToast = jest.fn();
jest.mock('@/android/settings/kit', () => ({
  showToast: (...args: unknown[]) => mockToast(...args),
}));
jest.mock('../settings/kit', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));
jest.mock('react-native-svg', () => {
  const Stub = () => null;
  return {
    __esModule: true,
    default: Stub,
    Circle: Stub,
    Defs: Stub,
    LinearGradient: Stub,
    Path: Stub,
    RadialGradient: Stub,
    Rect: Stub,
    Stop: Stub,
  };
});
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { getLocale: () => 'en-US', openEmailApp: () => true },
}));

import AuthScreen from '@/screens/AuthScreen.android';
import { ResetPasswordScreen } from '../auth/ResetPasswordScreen';
import { handleAuthBack } from '../auth/backPress';

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  mockAuth = {
    user: null,
    isLoading: false,
    loadingProvider: null,
    error: null,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signInWithGoogle: jest.fn(),
    signInWithMicrosoft: jest.fn(),
    continueAsGuest: jest.fn(),
    clearError: jest.fn(() => mockSetAuth({ error: null })),
  };
});

describe('Android sign-in screen', () => {
  it('shows Back and the guest link in onboarding (1.1)', () => {
    const onClose = jest.fn();
    const onGuest = jest.fn();
    const view = render(
      <AuthScreen variant="onboarding" onClose={onClose} onGuestContinue={onGuest} />,
    );
    expect(view.getByText('Privacy-first\nVoice-to-text AI')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Back'));
    expect(onClose).toHaveBeenCalled();
    fireEvent.press(view.getByText('Continue without an account'));
    expect(onGuest).toHaveBeenCalled();
  });

  it('shows Close and the reason in the app, without the guest link (1.2)', () => {
    const view = render(<AuthScreen reason="sync" hideGuestContinue onClose={jest.fn()} />);
    expect(view.getByText('Back up and sync your notes')).toBeTruthy();
    expect(view.getByLabelText('Close sign in')).toBeTruthy();
    expect(view.queryByText('Continue without an account')).toBeNull();
  });

  it('goes to Welcome back for a known email and shows a wrong password under the field', async () => {
    mockCheckUser.mockResolvedValue('signin');
    mockAuth.signIn.mockImplementation(async () =>
      mockSetAuth({ error: 'Invalid email or password' }),
    );
    const view = render(<AuthScreen onClose={jest.fn()} />);
    fireEvent.changeText(view.getByLabelText('Email address'), 'alex@example.com');
    fireEvent.press(view.getByText('Continue'));
    await waitFor(() => expect(view.getByText('Welcome back')).toBeTruthy());
    fireEvent.changeText(view.getByLabelText('Password'), 'wrong-one');
    await act(async () => fireEvent.press(view.getByText('Sign in')));
    expect(mockAuth.signIn).toHaveBeenCalledWith('alex@example.com', 'wrong-one');
    expect(view.getByText('That password doesn’t match. Try again or reset it.')).toBeTruthy();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('refuses a short password on sign-up before asking the server', async () => {
    mockCheckUser.mockResolvedValue('signup');
    const view = render(<AuthScreen onClose={jest.fn()} />);
    fireEvent.changeText(view.getByLabelText('Email address'), 'new@example.com');
    fireEvent.press(view.getByText('Continue'));
    await waitFor(() => expect(view.getAllByText('Create account').length).toBeGreaterThan(0));
    fireEvent.changeText(view.getByLabelText('Password'), 'short');
    fireEvent.press(view.getAllByText('Create account')[1]);
    expect(mockAuth.signUp).not.toHaveBeenCalled();
    expect(view.getByText('Use at least 8 characters.')).toBeTruthy();
  });

  it('signs the expired account in again, with another account one tap away (2.5, 2.5c)', () => {
    const view = render(<AuthScreen signInAgainEmail="alex@example.com" onClose={jest.fn()} />);
    expect(view.getByText('Sign in again')).toBeTruthy();
    expect(view.getByText('alex@example.com')).toBeTruthy();
    fireEvent.press(view.getByText('Use another account'));
    expect(
      view.getByText('You were signed out of alex@example.com. Sign in with a different account.'),
    ).toBeTruthy();
    fireEvent.press(view.getByLabelText('Back'));
    expect(view.getByText('Sign in again')).toBeTruthy();
  });

  it('offers the Google button to an account that signed in with Google (2.5b)', () => {
    store.set('android-sign-in-methods', JSON.stringify({ 'alex@example.com': 'google' }));
    const view = render(<AuthScreen signInAgainEmail="alex@example.com" onClose={jest.fn()} />);
    expect(view.getByText('Continue with Google')).toBeTruthy();
    expect(view.queryByLabelText('Password')).toBeNull();
    fireEvent.press(view.getByText('Continue with Google'));
    expect(mockAuth.signInWithGoogle).toHaveBeenCalled();
  });

  it('sends a reset link with the sign-in email and counts down the resend (3.1–3.6)', async () => {
    mockRequestReset.mockResolvedValue({ status: 200 });
    const view = render(<AuthScreen signInAgainEmail="alex@example.com" onClose={jest.fn()} />);
    fireEvent.press(view.getByText('Forgot password?'));
    expect(view.getByText('Reset your password')).toBeTruthy();
    await act(async () => fireEvent.press(view.getByText('Send reset link')));
    expect(mockRequestReset).toHaveBeenCalledWith(
      'alex@example.com',
      'https://openwhispr.com/android-reset-password',
    );
    expect(view.getByText('Check your email')).toBeTruthy();
    expect(view.getByText('Resend in 1:00')).toBeTruthy();

    mockRequestReset.mockResolvedValue({ status: 429, retryAfter: '299' });
    fireEvent.press(view.getByText('Use a different email'));
    await act(async () => fireEvent.press(view.getByText('Send reset link')));
    expect(view.getByText('Resend in 4:59')).toBeTruthy();
    expect(mockToast).toHaveBeenCalledWith('Too many tries. Wait a few minutes.', 'neutral');
  });

  it('steps back inside the screen on the system back gesture before leaving it', () => {
    const onClose = jest.fn();
    const view = render(<AuthScreen signInAgainEmail="alex@example.com" onClose={onClose} />);
    fireEvent.press(view.getByText('Forgot password?'));
    expect(view.getByText('Reset your password')).toBeTruthy();
    let used = false;
    act(() => {
      used = handleAuthBack();
    });
    expect(used).toBe(true);
    expect(view.getByText('Sign in again')).toBeTruthy();
    // On its first step the press belongs to whatever hosts the screen.
    act(() => {
      used = handleAuthBack();
    });
    expect(used).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('checks the address before sending (3.2)', async () => {
    const view = render(<AuthScreen signInAgainEmail="alex@example.com" onClose={jest.fn()} />);
    fireEvent.press(view.getByText('Forgot password?'));
    fireEvent.changeText(view.getByLabelText('Email address'), 'alex@example');
    fireEvent.press(view.getByText('Send reset link'));
    expect(mockRequestReset).not.toHaveBeenCalled();
    expect(view.getByText('Enter a full email address, like name@example.com.')).toBeTruthy();
  });
});

describe('Android reset link screen', () => {
  it('shows the expired screen for an invalid link (3.10)', () => {
    const view = render(
      <ResetPasswordScreen invalid onSignIn={jest.fn()} onContinue={jest.fn()} />,
    );
    expect(view.getByText('This link has expired')).toBeTruthy();
    expect(view.getByText('Send a new link')).toBeTruthy();
  });

  it('marks a short password only after Save (3.8)', () => {
    const view = render(
      <ResetPasswordScreen token="t" invalid={false} onSignIn={jest.fn()} onContinue={jest.fn()} />,
    );
    fireEvent.changeText(view.getByLabelText('New password'), 'short');
    expect(view.queryByText('Use at least 8 characters.')).toBeNull();
    fireEvent.press(view.getByText('Save password'));
    expect(view.getByText('Use at least 8 characters.')).toBeTruthy();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('signs in with the new password when this phone asked for the link (3.11)', async () => {
    store.set(
      'android-password-reset',
      JSON.stringify({ email: 'alex@example.com', at: Date.now() }),
    );
    mockResetPassword.mockResolvedValue({ status: 200 });
    mockAuth.signIn.mockImplementation(async () =>
      mockSetAuth({ user: { id: 'u', email: 'alex@example.com', isAnonymous: false } }),
    );
    const onContinue = jest.fn();
    const view = render(
      <ResetPasswordScreen
        token="t"
        invalid={false}
        onSignIn={jest.fn()}
        onContinue={onContinue}
      />,
    );
    expect(view.getByText('alex@example.com')).toBeTruthy();
    fireEvent.changeText(view.getByLabelText('New password'), 'river-maple-77');
    await act(async () => fireEvent.press(view.getByText('Save password')));
    expect(mockResetPassword).toHaveBeenCalledWith('river-maple-77', 't');
    expect(mockAuth.signIn).toHaveBeenCalledWith('alex@example.com', 'river-maple-77');
    expect(view.getByText('Password updated')).toBeTruthy();
    fireEvent.press(view.getByText('Continue'));
    expect(onContinue).toHaveBeenCalled();
    expect(store.has('android-password-reset')).toBe(false);
  });
});
