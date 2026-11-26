import { Platform } from 'react-native';
import { startKeyboardCredentialSync } from '@/lib/keyboardCredentialSync';

const mockSetCredential = jest.fn((_cookie: string | null) => true);

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    supportsKeyboardDirectDictation: true,
    setKeyboardSessionCredential: (cookie: string | null) => mockSetCredential(cookie),
  },
}));

jest.mock('@/store/useConfigStore', () => {
  const { create } = jest.requireActual('zustand');
  return { useConfigStore: create(() => ({ config: { keyboardDirectDictation: true } })) };
});

import { useConfigStore } from '@/store/useConfigStore';

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

const originalOS = Platform.OS;
const originalVersion = Object.getOwnPropertyDescriptor(Platform, 'Version');
function setIOSVersion(version: string): void {
  Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
}

afterAll(() => {
  Platform.OS = originalOS;
  if (originalVersion) Object.defineProperty(Platform, 'Version', originalVersion);
});

beforeEach(() => {
  Platform.OS = 'ios';
  setIOSVersion('26.1');
  useConfigStore.setState({ config: { defaultMode: 'cloud', keyboardDirectDictation: true } });
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

  it('only shares a session while direct dictation is enabled', () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud', keyboardDirectDictation: false } });
    useAuthStore.setState({ user: realUser, sessionCookie: 'a=1' });
    const stop = startKeyboardCredentialSync();
    try {
      useConfigStore.setState({ config: { defaultMode: 'cloud', keyboardDirectDictation: true } });
      useConfigStore.setState({ config: { defaultMode: 'cloud', keyboardDirectDictation: false } });
      expect(mockSetCredential.mock.calls).toEqual([[null], [credential('u1', 'a=1')], [null]]);
    } finally {
      stop();
    }
  });

  it('shares the session by default when the setting was never changed', () => {
    useConfigStore.setState({ config: { defaultMode: 'cloud' } });
    useAuthStore.setState({ user: realUser, sessionCookie: 'a=1' });
    const stop = startKeyboardCredentialSync();
    expect(mockSetCredential.mock.calls).toEqual([[credential('u1', 'a=1')]]);
    stop();
  });

  it('shares nothing with a keyboard that cannot record by itself (iOS 18)', () => {
    setIOSVersion('18.7');
    useConfigStore.setState({ config: { defaultMode: 'cloud' } });
    useAuthStore.setState({ user: realUser, sessionCookie: 'a=1' });
    const stop = startKeyboardCredentialSync();
    expect(mockSetCredential.mock.calls).toEqual([[null]]);
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
