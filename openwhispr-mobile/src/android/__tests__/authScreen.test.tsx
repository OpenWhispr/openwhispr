// Shared files reach Android's copies through these paths, as Metro's re-exports do.
jest.mock('@/services/transcription/TranscriptionService', () =>
  jest.requireActual('@/android/transcription/TranscriptionService'),
);
jest.mock('@/services/transcription/LocalTranscriptionService', () =>
  jest.requireActual('@/android/transcription/LocalTranscriptionService'),
);
jest.mock('@/services/transcription/parakeetSegments', () =>
  jest.requireActual('@/android/transcription/parakeetSegments'),
);
jest.mock('@/services/diarization/DiarizationService', () =>
  jest.requireActual('@/android/transcription/DiarizationService'),
);
jest.mock('@/lib/cleanupTranscript', () =>
  jest.requireActual('@/android/dictation/cleanupTranscript'),
);
jest.mock('@/lib/transcribeAndCleanup', () =>
  jest.requireActual('@/android/dictation/transcribeAndCleanup'),
);
jest.mock('@/lib/localReasoningFallback', () =>
  jest.requireActual('@/android/dictation/localReasoningFallback'),
);
jest.mock('@/lib/snippets', () => jest.requireActual('@/android/dictation/snippets'));
jest.mock('@/lib/mobileProviders', () => jest.requireActual('@/android/providers/mobileProviders'));
jest.mock('@/services/reasoning/ReasoningService', () =>
  jest.requireActual('@/android/reasoning/ReasoningService'),
);
jest.mock('@/services/reasoning/buildProviderPrompt', () =>
  jest.requireActual('@/android/reasoning/buildProviderPrompt'),
);
jest.mock('@/services/agent/composerPrompt', () =>
  jest.requireActual('@/android/reasoning/composerPrompt'),
);
jest.mock('@/data/remote/usageApi', () => jest.requireActual('@/android/remote/usageApi'));
jest.mock('@/store/useConfigStore', () => jest.requireActual('@/android/store/useConfigStore'));
jest.mock('@/store/useDictionaryStore', () =>
  jest.requireActual('@/android/store/useDictionaryStore'),
);
jest.mock('@/store/useNotesStore', () => jest.requireActual('@/android/store/useNotesStore'));
jest.mock('@/store/useSnippetsStore', () => jest.requireActual('@/android/store/useSnippetsStore'));
jest.mock('@/store/useTranscriptStore', () =>
  jest.requireActual('@/android/store/useTranscriptStore'),
);
jest.mock('@/store/useUsageStore', () => jest.requireActual('@/android/store/useUsageStore'));
jest.mock('@/data/local/notesRepository', () =>
  jest.requireActual('@/android/data/notesRepository'),
);
jest.mock('@/sync/pullSharedDictionary', () =>
  jest.requireActual('@/android/sync/pullSharedDictionary'),
);
jest.mock('@/sync/syncEngine', () => jest.requireActual('@/android/sync/syncEngine'));
jest.mock('@/sync/ensureNoteSynced', () => jest.requireActual('@/android/sync/ensureNoteSynced'));
jest.mock('@/db/schema', () => jest.requireActual('@/android/db/schema'));
jest.mock('@/lib/keyboardInferenceRoute', () =>
  jest.requireActual('@/android/lib/keyboardInferenceRoute'),
);
jest.mock('@/lib/meetingRecovery', () =>
  jest.requireActual('@/android/lib/meetingRecoveryAndroid'),
);
jest.mock('@/lib/notes/localMeetingNotes', () =>
  jest.requireActual('@/android/lib/notes/localMeetingNotes'),
);
jest.mock('@/hooks/useActionProcessing', () =>
  jest.requireActual('@/android/hooks/useActionProcessing'),
);
jest.mock('@/hooks/useAudioRecording', () =>
  jest.requireActual('@/android/hooks/useAudioRecording'),
);
jest.mock('@/hooks/useChatSendGate', () => jest.requireActual('@/android/hooks/useChatSendGate'));
jest.mock('@/hooks/useFileUpload', () => jest.requireActual('@/android/hooks/useFileUpload'));
jest.mock('@/hooks/useNoteSharing', () => jest.requireActual('@/android/hooks/useNoteSharing'));
jest.mock('@/hooks/useSheetDragToDismiss', () =>
  jest.requireActual('@/android/hooks/useSheetDragToDismiss'),
);
jest.mock('@/hooks/useUsageLimitRecovery', () =>
  jest.requireActual('@/android/hooks/useUsageLimitRecovery'),
);
jest.mock('@/lib/formatNoteRowTime', () => jest.requireActual('@/android/lib/formatNoteRowTime'));
jest.mock('@/lib/groupNotesByDate', () => jest.requireActual('@/android/lib/groupNotesByDate'));
jest.mock('@/lib/notes/generateNotesPrompt', () =>
  jest.requireActual('@/android/lib/notes/generateNotesPrompt'),
);
jest.mock('@/lib/notes/noteChatSuggestions', () =>
  jest.requireActual('@/android/lib/notes/noteChatSuggestions'),
);
jest.mock('@/lib/notes/noteMeta', () => jest.requireActual('@/android/lib/notes/noteMeta'));
jest.mock('@/utils/generateTitle', () => jest.requireActual('@/android/utils/generateTitle'));
jest.mock('@/lib/alerts', () => jest.requireActual('@/android/lib/alerts'));
jest.mock('@/lib/appsflyer', () => jest.requireActual('@/android/lib/appsflyer'));
jest.mock('@/lib/productEvents', () => jest.requireActual('@/android/lib/productEvents'));
jest.mock('@/lib/referralApi', () => jest.requireActual('@/android/lib/referralApi'));
jest.mock('@/lib/sentry', () => jest.requireActual('@/android/lib/sentry'));
jest.mock('@/lib/accountAccess', () => jest.requireActual('@/android/lib/accountAccess'));
jest.mock('@/lib/onboardingMode', () => jest.requireActual('@/android/lib/onboardingMode'));
jest.mock('@/lib/revenuecat', () => jest.requireActual('@/android/lib/revenuecat'));
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
  user: { id: string; email: string; isAnonymous: boolean; emailVerified?: boolean } | null;
  isLoading: boolean;
  loadingProvider: 'google' | 'microsoft' | null;
  error: string | null;
  signIn: jest.Mock;
  signUp: jest.Mock;
  signOut: jest.Mock;
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
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
const mockCheckUser = jest.fn();
jest.mock('@/lib/authClient', () => ({ checkUserExists: (email: string) => mockCheckUser(email) }));
jest.mock('@/android/lib/authClient', () => ({
  ...jest.requireMock('@/lib/authClient'),
  ...jest.requireMock('@/lib/authClient.android'),
}));
const mockRequestReset = jest.fn();
const mockResetPassword = jest.fn();
const mockRequestVerification = jest.fn();
jest.mock('@/lib/authClient.android', () => ({
  requestPasswordResetEmail: (...args: unknown[]) => mockRequestReset(...args),
  resetPasswordWithToken: (...args: unknown[]) => mockResetPassword(...args),
  requestVerificationEmail: (...args: unknown[]) => mockRequestVerification(...args),
}));
const mockVerificationStatus = jest.fn();
const mockVerifyToken = jest.fn();
jest.mock('@/android/lib/sessionFetch', () => ({
  sessionFetch: (...args: unknown[]) => mockVerifyToken(...args),
}));
jest.mock('@/lib/apiClient', () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, mockStatus: number, mockCode?: string) {
      super(message);
      this.status = mockStatus;
      this.code = mockCode;
    }
  }
  return {
    ApiError,
    BASE_URL: 'https://api.test',
    getClientVersionHeader: () => ({}),
    api: {
      get: (...args: unknown[]) => mockVerificationStatus(...args),
      post: (...args: unknown[]) => mockVerifyToken(...args),
    },
  };
});
jest.mock('@/android/lib/apiClient', () => jest.requireMock('@/lib/apiClient'));
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
jest.mock('../navigationBar', () => ({ useNavigationBarCanvas: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { getLocale: () => 'en-US', openEmailApp: () => true },
}));

import AuthScreen from '@/screens/AuthScreen.android';
import { ResetPasswordScreen } from '../auth/ResetPasswordScreen';
import { handleAuthBack } from '../auth/backPress';
import { VerifyLinkScreen } from '../auth/VerifyLinkScreen';

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
    signOut: jest.fn(async () => mockSetAuth({ user: null })),
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

describe('Android verify email (section 6)', () => {
  const unverified = {
    id: 'u',
    email: 'new@example.com',
    isAnonymous: false,
    emailVerified: false,
  };

  it('waits on Verify your email after sign-up, then says Email verified (6.1, 6.5)', async () => {
    mockCheckUser.mockResolvedValue('signup');
    mockVerificationStatus.mockResolvedValue({ verified: false });
    mockAuth.signUp.mockImplementation(async () => mockSetAuth({ user: unverified }));
    const view = render(<AuthScreen onClose={jest.fn()} />);
    fireEvent.changeText(view.getByLabelText('Email address'), 'new@example.com');
    fireEvent.press(view.getByText('Continue'));
    await waitFor(() => expect(view.getAllByText('Create account').length).toBeGreaterThan(0));
    fireEvent.changeText(view.getByLabelText('Password'), 'river-maple-77');
    await act(async () => fireEvent.press(view.getAllByText('Create account')[1]));
    expect(view.getByText('Verify your email')).toBeTruthy();
    expect(view.getByText('Resend in 1:00')).toBeTruthy();
    expect(view.getByText('Use a different email')).toBeTruthy();
    expect(mockVerificationStatus).toHaveBeenCalledWith('/api/auth/verification-status');

    mockVerificationStatus.mockResolvedValue({ verified: true });
    // The next 5 s check sees it.
    await waitFor(() => expect(view.getByText('Email verified')).toBeTruthy(), { timeout: 7000 });
    // 6.5 has no Back: it would sign the new account out.
    expect(view.queryByLabelText('Back')).toBeNull();
    fireEvent.press(view.getByText('Continue'));
    expect(mockAuth.user?.emailVerified).toBe(true);
  }, 10000);

  it('offers Resend at once to an account that never verified, and Use another account (6.4)', async () => {
    mockAuth.user = unverified;
    mockVerificationStatus.mockResolvedValue({ verified: false });
    mockRequestVerification.mockResolvedValue({ status: 429, retryAfter: '299' });
    const view = render(<AuthScreen onClose={jest.fn()} />);
    expect(view.getByText('Verify your email')).toBeTruthy();
    await act(async () => fireEvent.press(view.getByText('Resend link')));
    expect(mockRequestVerification).toHaveBeenCalledWith('new@example.com');
    expect(view.getByText('Resend in 4:59')).toBeTruthy();
    expect(mockToast).toHaveBeenCalledWith('Too many tries. Wait a few minutes.', 'neutral');
    await act(async () => fireEvent.press(view.getByText('Use another account')));
    expect(mockAuth.signOut).toHaveBeenCalled();
    expect(view.getByText('Privacy-first\nVoice-to-text AI')).toBeTruthy();
  });
});

describe('Android verify link screen (6.5, 6.6)', () => {
  const jwtFor = (email: string) =>
    `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
  const signedIn = { id: 'u', email: 'new@example.com', isAnonymous: false, emailVerified: false };
  const answer = (status: number) => ({ ok: status === 200, status });

  it('verifies the link without the app session and continues as that account', async () => {
    mockAuth.user = signedIn;
    mockVerifyToken.mockResolvedValue(answer(200));
    const onContinue = jest.fn();
    const token = jwtFor('new@example.com');
    const view = render(
      <VerifyLinkScreen token={token} onContinue={onContinue} onSignIn={jest.fn()} />,
    );
    await waitFor(() => expect(view.getByText('Email verified')).toBeTruthy());
    const [url, init] = mockVerifyToken.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/auth/verify-email');
    expect(JSON.parse(init.body as string)).toEqual({ token });
    expect((init.headers as Record<string, string>).Cookie).toBeUndefined();
    fireEvent.press(view.getByText('Continue'));
    expect(mockAuth.user?.emailVerified).toBe(true);
    expect(onContinue).toHaveBeenCalled();
  });

  it('never touches a phone signed in as another account', async () => {
    mockAuth.user = { ...signedIn, email: 'someone@example.com' };
    mockVerifyToken.mockResolvedValue(answer(200));
    const onSignIn = jest.fn();
    const view = render(
      <VerifyLinkScreen
        token={jwtFor('new@example.com')}
        onContinue={jest.fn()}
        onSignIn={onSignIn}
      />,
    );
    await waitFor(() => expect(view.getByText('Email verified')).toBeTruthy());
    expect(view.getByText('Your email is verified. Sign in to continue.')).toBeTruthy();
    fireEvent.press(view.getByText('Sign in'));
    expect(onSignIn).toHaveBeenCalled();
    expect(mockAuth.user?.emailVerified).toBe(false);
  });

  it('shows This link has expired, and Send a new link goes to Verify your email', async () => {
    mockAuth.user = signedIn;
    mockVerifyToken.mockResolvedValue(answer(401));
    mockVerificationStatus.mockResolvedValue({ verified: false });
    mockRequestVerification.mockResolvedValue({ status: 200 });
    const view = render(
      <VerifyLinkScreen
        token={jwtFor('new@example.com')}
        onContinue={jest.fn()}
        onSignIn={jest.fn()}
      />,
    );
    await waitFor(() => expect(view.getByText('This link has expired')).toBeTruthy());
    expect(view.getByDisplayValue('new@example.com')).toBeTruthy();
    await act(async () => fireEvent.press(view.getByText('Send a new link')));
    expect(mockRequestVerification).toHaveBeenCalledWith('new@example.com');
    expect(view.getByText('Verify your email')).toBeTruthy();
    expect(view.getByText('Resend in 1:00')).toBeTruthy();
  });

  it('offers Try again, not a new link, when OpenWhispr can’t be reached', async () => {
    mockAuth.user = signedIn;
    mockVerifyToken.mockResolvedValueOnce(answer(429)).mockResolvedValueOnce(answer(200));
    mockVerificationStatus.mockResolvedValue({ verified: false });
    const view = render(
      <VerifyLinkScreen
        token={jwtFor('new@example.com')}
        onContinue={jest.fn()}
        onSignIn={jest.fn()}
      />,
    );
    await waitFor(() => expect(view.getByText('Couldn’t verify your email')).toBeTruthy());
    expect(view.queryByText('This link has expired')).toBeNull();
    expect(view.queryByText('Send a new link')).toBeNull();
    await act(async () => fireEvent.press(view.getByText('Try again')));
    await waitFor(() => expect(view.getByText('Email verified')).toBeTruthy());
    expect(mockVerifyToken).toHaveBeenCalledTimes(2);
    expect(mockRequestVerification).not.toHaveBeenCalled();
  });

  it('treats a dropped connection like an unreachable server', async () => {
    mockAuth.user = signedIn;
    mockVerifyToken.mockRejectedValue(new TypeError('Network request failed'));
    mockVerificationStatus.mockResolvedValue(null);
    const view = render(
      <VerifyLinkScreen
        token={jwtFor('new@example.com')}
        onContinue={jest.fn()}
        onSignIn={jest.fn()}
      />,
    );
    await waitFor(() => expect(view.getByText('Couldn’t verify your email')).toBeTruthy());
  });

  it('skips the expired screen for an account that is verified already', async () => {
    mockAuth.user = signedIn;
    mockVerifyToken.mockResolvedValue(answer(401));
    mockVerificationStatus.mockResolvedValue({ verified: true });
    const view = render(
      <VerifyLinkScreen
        token={jwtFor('new@example.com')}
        onContinue={jest.fn()}
        onSignIn={jest.fn()}
      />,
    );
    await waitFor(() => expect(view.getByText('Email verified')).toBeTruthy());
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
