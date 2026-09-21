import { parseApiErrorBody } from '@/lib/apiErrorBody';
import {
  ACCOUNT_REQUIRED_CODE,
  AccountRequiredError,
  isAccountRequiredError,
} from '@/lib/accountRequiredError';

describe('parseApiErrorBody', () => {
  // The regression this exists for: the client read `.message`, which is
  // undefined for the API's own `{ error }` envelope, so a gated endpoint
  // surfaced to the user as the literal string "HTTP 403".
  it('reads the message and code the account gate sends', () => {
    expect(
      parseApiErrorBody({
        error: 'Create an account to use this feature',
        code: 'ACCOUNT_REQUIRED',
      }),
    ).toEqual({ message: 'Create an account to use this feature', code: 'ACCOUNT_REQUIRED' });
  });

  it('reads the plain { error } envelope most endpoints use', () => {
    expect(parseApiErrorBody({ error: 'Weekly word limit reached' })).toEqual({
      message: 'Weekly word limit reached',
      code: undefined,
    });
  });

  it('reads the nested { error: { code, message } } envelope from /api/v1', () => {
    expect(
      parseApiErrorBody({ error: { code: 'unauthorized', message: 'Invalid token' } }),
    ).toEqual({ message: 'Invalid token', code: 'unauthorized' });
  });

  it("reads Better Auth's { message, code } envelope", () => {
    expect(parseApiErrorBody({ message: 'Too many requests', code: 'RATE_LIMITED' })).toEqual({
      message: 'Too many requests',
      code: 'RATE_LIMITED',
    });
  });

  it('parses a raw JSON string body, for transports that never decode it', () => {
    expect(parseApiErrorBody('{"error":"nope","code":"ACCOUNT_REQUIRED"}')).toEqual({
      message: 'nope',
      code: 'ACCOUNT_REQUIRED',
    });
  });

  it('yields nothing rather than throwing on a non-JSON or empty body', () => {
    expect(parseApiErrorBody('<html>502</html>')).toEqual({});
    expect(parseApiErrorBody(null)).toEqual({});
    expect(parseApiErrorBody(undefined)).toEqual({});
  });
});

describe('isAccountRequiredError', () => {
  it('recognizes the typed error', () => {
    const error = new AccountRequiredError();
    expect(error.status).toBe(403);
    expect(error.code).toBe(ACCOUNT_REQUIRED_CODE);
    expect(isAccountRequiredError(error)).toBe(true);
  });

  // What apiClient and AgentStreamClient actually throw: an ApiError carrying
  // the server's code. The guard is duck-typed so both transports work.
  it('recognizes any error carrying the code', () => {
    expect(
      isAccountRequiredError({ name: 'ApiError', status: 403, code: 'ACCOUNT_REQUIRED' }),
    ).toBe(true);
  });

  it('does not classify an unrelated 403 as account-required', () => {
    expect(isAccountRequiredError({ name: 'ApiError', status: 403 })).toBe(false);
    expect(isAccountRequiredError({ name: 'ApiError', status: 403, code: 'FORBIDDEN' })).toBe(
      false,
    );
    expect(isAccountRequiredError(new Error('HTTP 403'))).toBe(false);
    expect(isAccountRequiredError(null)).toBe(false);
  });
});

// accountAccess pulls in Alert, the router and the auth store; stub those
// surfaces so the predicates and the alert's wiring can be exercised directly.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
type MockAuthState = { user: { id: string; isAnonymous: boolean } | null };
let mockAuthStoreState: MockAuthState = { user: null };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => mockAuthStoreState },
}));

describe('requiresRealAccount', () => {
  const { accountRequiredForCloud, canRunCloudMeeting, requiresRealAccount } =
    jest.requireActual<typeof import('@/lib/accountAccess')>('@/lib/accountAccess');

  const anonymous = {
    id: 'a',
    email: 'temp-1@anon.openwhispr.invalid',
    emailVerified: false,
    isAnonymous: true,
  };
  const real = { id: 'r', email: 'real@example.com', emailVerified: true, isAnonymous: false };

  it('treats an anonymous onboarding session as no account', () => {
    expect(requiresRealAccount(anonymous)).toBe(true);
    expect(requiresRealAccount(null)).toBe(true);
    expect(requiresRealAccount(real)).toBe(false);
  });

  // The distinction that matters: cloud dictation is the whole point of the
  // anonymous session, and the API leaves /api/transcribe ungated for it.
  it('still lets an anonymous session use cloud transcription', () => {
    expect(accountRequiredForCloud(anonymous)).toBe(false);
    expect(accountRequiredForCloud(null)).toBe(true);
  });

  // The realtime token behind cloud meetings is account-gated, so an anonymous
  // session takes the local path like a guest does, rather than recording a
  // whole meeting into a session that can never connect.
  it('routes anonymous sessions and guests to local meetings', () => {
    expect(canRunCloudMeeting(real, 'cloud')).toBe(true);
    expect(canRunCloudMeeting(real, 'private')).toBe(false);
    expect(canRunCloudMeeting(anonymous, 'cloud')).toBe(false);
    expect(canRunCloudMeeting(null, 'cloud')).toBe(false);
  });
});

describe('showAccountRequiredAlert', () => {
  const { showAccountRequiredAlert } =
    jest.requireActual<typeof import('@/lib/accountAccess')>('@/lib/accountAccess');
  const { Alert } = jest.requireMock('react-native') as { Alert: { alert: jest.Mock } };
  const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };

  type AlertButton = { text: string; onPress?: () => void };
  function lastAlert(): { title: string; message: string; buttons: AlertButton[] } {
    const [title, message, buttons] = Alert.alert.mock.calls.at(-1) as [
      string,
      string,
      AlertButton[],
    ];
    return { title, message, buttons };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // An anonymous session already has a user; what it lacks is an account, and
  // the Account screen has nothing for it. Send it straight to sign-up.
  it('asks an anonymous session to create an account and opens the auth modal', () => {
    mockAuthStoreState = { user: { id: 'anon-user', isAnonymous: true } };

    showAccountRequiredAlert('AI actions', { cloudOnly: true });

    const { title, message, buttons } = lastAlert();
    expect(title).toBe('Create an account');
    expect(message).toMatch(/^Create an account to use AI actions/);
    buttons.find((button) => button.text === 'Create Account')?.onPress?.();
    expect(router.push).toHaveBeenCalledWith('/auth');
  });

  it('keeps the sign-in prompt for a guest', () => {
    mockAuthStoreState = { user: null };

    showAccountRequiredAlert('AI actions', { cloudOnly: true });

    const { title, message, buttons } = lastAlert();
    expect(title).toBe('Sign in required');
    expect(message).toMatch(/^Sign in to use AI actions/);
    buttons.find((button) => button.text === 'Account')?.onPress?.();
    expect(router.push).toHaveBeenCalledWith('/(account)');
  });
});
