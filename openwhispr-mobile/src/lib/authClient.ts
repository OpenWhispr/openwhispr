import { createAuthApi, createNativeAuthClient } from './authClientCore';
export type { AuthUser, AuthResult, AnonymousAuthResult, SocialAuthResult } from './authClientCore';

export const {
  getStoredSession,
  clearSession,
  getSession,
  signInWithEmail,
  signUpWithEmail,
  signInAnonymously,
  signOut,
  signInWithGoogle,
  signInWithApple,
  signInWithMicrosoft,
  deleteAccount,
  initAuthenticatedUser,
  checkUserExists,
} = createAuthApi(createNativeAuthClient());
