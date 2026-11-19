const mockSocial = jest.fn();
const mockGetSession = jest.fn();
const mockBrowser = jest.fn();
const mockSheet = jest.fn();
let mockSheetAvailable = true;

jest.mock('../../lib/authClientCore', () => ({
  COOKIE_STORAGE_KEY: 'c',
  SESSION_DATA_STORAGE_KEY: 's',
  mapAuthUser: (user: unknown) => user,
  createNativeAuthClient: () => ({
    signIn: { social: (...args: unknown[]) => mockSocial(...args) },
    getSession: (...args: unknown[]) => mockGetSession(...args),
  }),
  createAuthApi: () => ({
    getStoredSession: async () => 'openwhispr.session_token=abc',
    signInWithGoogle: () => mockBrowser(),
  }),
}));
jest.mock('../../lib/sessionFetch.android', () => ({ sessionFetch: jest.fn() }));
jest.mock('@better-auth/expo/client', () => ({ storageAdapter: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'nonce-1' }));
jest.mock('../../../modules/android-google-authorization/src', () => ({
  isGoogleSignInAvailable: () => mockSheetAvailable,
  signInWithGoogleSheet: (...args: unknown[]) => mockSheet(...args),
}));

import { signInWithGoogle } from '../../lib/authClient.android';

beforeEach(() => {
  jest.clearAllMocks();
  mockSheetAvailable = true;
  mockGetSession.mockResolvedValue({ data: null });
});

describe('Android Google sign-in (1.8)', () => {
  it('signs in with the ID token from Android’s sheet, issued for the API’s web client', async () => {
    mockSheet.mockResolvedValue({ idToken: 'id-token', email: 'alex@example.com' });
    mockSocial.mockResolvedValue({ data: { user: { id: 'u' }, token: 't' }, error: null });
    await expect(signInWithGoogle()).resolves.toEqual({
      success: true,
      sessionCookie: 'openwhispr.session_token=abc',
      error: null,
    });
    expect(mockSheet).toHaveBeenCalledWith(
      '296701228479-22st3am22trhukoo8gi0npfgq2c5oco4.apps.googleusercontent.com',
      'nonce-1',
    );
    expect(mockSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        idToken: { token: 'id-token', nonce: 'nonce-1' },
      }),
    );
    expect(mockBrowser).not.toHaveBeenCalled();
  });

  it('says nothing when the sheet is dismissed', async () => {
    mockSheet.mockRejectedValue(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    await expect(signInWithGoogle()).resolves.toEqual({
      success: false,
      sessionCookie: null,
      error: null,
    });
    expect(mockSocial).not.toHaveBeenCalled();
    expect(mockBrowser).not.toHaveBeenCalled();
  });

  it('falls back to the browser when the sheet fails or the build has none', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockBrowser.mockResolvedValue({ success: true, sessionCookie: 'x', error: null });
    mockSheet.mockRejectedValue(Object.assign(new Error('no'), { code: 'FAILED' }));
    await signInWithGoogle();
    mockSheetAvailable = false;
    await signInWithGoogle();
    expect(mockBrowser).toHaveBeenCalledTimes(2);
  });

  it('reports the API refusing the token', async () => {
    mockSheet.mockResolvedValue({ idToken: 'id-token', email: 'alex@example.com' });
    mockSocial.mockResolvedValue({ data: null, error: { message: 'Invalid token' } });
    await expect(signInWithGoogle()).resolves.toEqual({
      success: false,
      sessionCookie: null,
      error: 'Invalid token',
    });
  });
});
