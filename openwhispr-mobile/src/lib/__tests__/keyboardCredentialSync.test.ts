import { startKeyboardCredentialSync } from '@/lib/keyboardCredentialSync';

const mockSetCredential = jest.fn((_cookie: string | null) => true);

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    setKeyboardSessionCredential: (cookie: string | null) => mockSetCredential(cookie),
  },
}));

// accountAccess pulls in the router for its sign-in alert, and the store for processing mode.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({}) },
}));

jest.mock('@/store/useAuthStore', () => {
  const { create } = jest.requireActual('zustand');
  return {
    useAuthStore: create(() => ({
      user: null,
      sessionCookie: null,
      isGuest: false,
      isLoading: false,
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useAuthStore } = require('@/store/useAuthStore');

const realUser = { id: 'u1', email: 'a@b.co', isAnonymous: false };
// The keyboard only uses the session for the account its snapshot names.
const credential = (userId: string, cookie: string) => JSON.stringify({ userId, cookie });

beforeEach(() => {
  mockSetCredential.mockClear();
  useAuthStore.setState({ user: null, sessionCookie: null, isGuest: false, isLoading: false });
});

describe('startKeyboardCredentialSync', () => {
  it('shares a real account session with the keyboard once', () => {
    useAuthStore.setState({ user: realUser, sessionCookie: 'better-auth.session_token=abc' });
    const stop = startKeyboardCredentialSync();
    expect(mockSetCredential.mock.calls).toEqual([
      [credential('u1', 'better-auth.session_token=abc')],
    ]);

    useAuthStore.setState({ isLoading: true });
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
    stop();
  });

  it('removes the credential for a guest', () => {
    useAuthStore.setState({ user: null, sessionCookie: null, isGuest: true });
    const stop = startKeyboardCredentialSync();
    expect(mockSetCredential.mock.calls).toEqual([[null]]);
    stop();
  });

  it('never shares an anonymous onboarding session', () => {
    useAuthStore.setState({ user: { ...realUser, isAnonymous: true }, sessionCookie: 'anon=1' });
    const stop = startKeyboardCredentialSync();
    expect(mockSetCredential.mock.calls).toEqual([[null]]);
    stop();
  });

  it('removes it on sign-out and replaces it for the next account', () => {
    useAuthStore.setState({ user: realUser, sessionCookie: 'a=1' });
    const stop = startKeyboardCredentialSync();
    useAuthStore.setState({ user: null, sessionCookie: null });
    useAuthStore.setState({ user: { ...realUser, id: 'u2' }, sessionCookie: 'b=2' });
    expect(mockSetCredential.mock.calls).toEqual([
      [credential('u1', 'a=1')],
      [null],
      [credential('u2', 'b=2')],
    ]);
    stop();
  });

  it('writes again after a failed write', () => {
    mockSetCredential.mockReturnValueOnce(false);
    useAuthStore.setState({ user: realUser, sessionCookie: 'a=1' });
    const stop = startKeyboardCredentialSync();
    useAuthStore.setState({ isLoading: false });
    expect(mockSetCredential.mock.calls).toEqual([
      [credential('u1', 'a=1')],
      [credential('u1', 'a=1')],
    ]);
    stop();
  });

  it('stops following the store once stopped', () => {
    const stop = startKeyboardCredentialSync();
    stop();
    useAuthStore.setState({ user: realUser, sessionCookie: 'a=1' });
    expect(mockSetCredential.mock.calls).toEqual([[null]]);
  });
});
