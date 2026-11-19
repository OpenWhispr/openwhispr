import {
  formatWait,
  forgetResetEmail,
  looksLikeEmail,
  pendingResetEmail,
  readRequestOutcome,
  readResetOutcome,
  rememberResetEmail,
} from '../auth/passwordReset';
import { lastSignInMethod, placeAuthError, rememberSignInMethod } from '../auth/authErrors';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
});

beforeEach(() => store.clear());

describe('password reset requests', () => {
  it('checks the address on the phone before sending (3.2)', () => {
    expect(looksLikeEmail('alex@example.com')).toBe(true);
    expect(looksLikeEmail(' alex@example.co.uk ')).toBe(true);
    expect(looksLikeEmail('alex@example')).toBe(false);
    expect(looksLikeEmail('alex example.com')).toBe(false);
  });

  it('reads the server’s answer without saying whether the email has an account', () => {
    expect(readRequestOutcome({ status: 200 })).toEqual({ kind: 'sent' });
    // Better Auth answers 200 for unknown emails too, so there is no "not found" outcome.
    expect(readRequestOutcome({ status: 400, code: 'X' })).toEqual({ kind: 'failed' });
    expect(readRequestOutcome({ status: null })).toEqual({ kind: 'network' });
    expect(readRequestOutcome({ status: 503 })).toEqual({ kind: 'network' });
  });

  it('waits out the rate limit for as long as the server says (3.6)', () => {
    expect(readRequestOutcome({ status: 429, retryAfter: '42' })).toEqual({
      kind: 'rateLimited',
      waitSeconds: 42,
    });
    expect(readRequestOutcome({ status: 429, retryAfter: null })).toEqual({
      kind: 'rateLimited',
      waitSeconds: 300,
    });
  });

  it('formats the countdown as the pill shows it', () => {
    expect(formatWait(60)).toBe('1:00');
    expect(formatWait(42)).toBe('0:42');
    expect(formatWait(299)).toBe('4:59');
    expect(formatWait(-3)).toBe('0:00');
  });
});

describe('setting the new password', () => {
  it('sends an old, used or mistyped link to the expired screen (3.10)', () => {
    expect(readResetOutcome({ status: 400, code: 'INVALID_TOKEN' })).toEqual({
      kind: 'invalidToken',
    });
    expect(readResetOutcome({ status: 400, code: 'PASSWORD_TOO_SHORT' })).toEqual({
      kind: 'tooShort',
    });
    expect(readResetOutcome({ status: 200 })).toEqual({ kind: 'saved' });
    expect(readResetOutcome({ status: 429 })).toEqual({ kind: 'rateLimited' });
  });

  it('remembers which email asked, for no longer than the link lives', () => {
    rememberResetEmail('alex@example.com', 1_000);
    expect(pendingResetEmail(1_000 + 59 * 60 * 1000)).toBe('alex@example.com');
    expect(pendingResetEmail(1_000 + 61 * 60 * 1000)).toBeNull();
    forgetResetEmail();
    expect(pendingResetEmail(1_000)).toBeNull();
  });
});

describe('sign-in errors', () => {
  it('puts a wrong password under the field and everything else in the toast', () => {
    expect(placeAuthError('Invalid email or password')).toEqual({
      place: 'password',
      key: 'wrongPassword',
    });
    expect(placeAuthError('Password too short')).toEqual({
      place: 'password',
      key: 'passwordTooShort',
    });
    expect(placeAuthError('Sign in failed. Check your connection and try again.')).toEqual({
      place: 'toast',
      key: 'networkError',
    });
    expect(placeAuthError('User already exists. Use another email.')).toEqual({
      place: 'toast',
      key: 'accountExists',
    });
    expect(placeAuthError('Email not verified')).toEqual({
      place: 'toast',
      text: 'Email not verified',
    });
  });

  it('offers the way an account last signed in when it signs in again (2.5b)', () => {
    expect(lastSignInMethod('alex@example.com')).toBe('email');
    rememberSignInMethod('Alex@Example.com', 'google');
    expect(lastSignInMethod('alex@example.com')).toBe('google');
  });
});
