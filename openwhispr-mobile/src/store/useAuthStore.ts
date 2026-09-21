import { create, type StoreApi } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import {
  getStoredSession,
  clearSession,
  signInWithEmail,
  signUpWithEmail,
  signOut as signOutApi,
  signInWithGoogle as signInWithGoogleApi,
  signInWithApple as signInWithAppleApi,
  signInWithMicrosoft as signInWithMicrosoftApi,
  signInAnonymously,
  deleteAccount as deleteAccountApi,
  getSession,
  initAuthenticatedUser,
  type AuthUser,
  type SocialAuthResult,
} from '@/lib/authClient';
import { Sentry } from '@/lib/sentry';
import { useUsageStore } from '@/store/useUsageStore';
import { clearAllSessions as clearAgentSessions } from '@/services/agent/AgentComposerService';

const GUEST_SESSION_KEY = 'openwhispr_guest_session';

// Explicit auth choices wait for the startup request to finish writing its cookie,
// including failures, so its late result cannot overwrite the chosen session.
let anonymousSignInInFlight: Promise<void> | null = null;

type SessionResult = {
  user: AuthUser | null;
  sessionCookie: string | null;
  error?: string | null;
};

interface AuthStore {
  user: AuthUser | null;
  sessionCookie: string | null;
  isGuest: boolean;
  isLoading: boolean;
  loadingProvider: 'google' | 'apple' | 'microsoft' | null;
  isInitialized: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithMicrosoft: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  ensureAnonymousSession: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  sessionCookie: null,
  isGuest: false,
  isLoading: false,
  loadingProvider: null,
  isInitialized: false,
  error: null,

  initialize: async () => {
    set({ isLoading: true });
    await anonymousSignInInFlight?.catch(() => undefined);
    try {
      const user = await getSession();
      if (user) {
        const sessionCookie = await getStoredSession();
        set({ user, sessionCookie, isGuest: false, isInitialized: true, isLoading: false });
      } else {
        const isGuest = (await SecureStore.getItemAsync(GUEST_SESSION_KEY)) === 'true';
        useUsageStore.getState().reset();
        set({ user: null, sessionCookie: null, isGuest, isInitialized: true, isLoading: false });
      }
    } catch {
      set({ isInitialized: true, isLoading: false });
    }
  },

  signIn: async (email, password) => {
    set({ isLoading: true, error: null });
    await anonymousSignInInFlight?.catch(() => undefined);
    const result = await signInWithEmail(email, password);
    if (result.error || !result.user) {
      set({ isLoading: false, error: result.error || 'Sign in failed' });
      return;
    }
    await applyAuthenticatedSession(set, result);
  },

  signUp: async (email, password, name) => {
    set({ isLoading: true, error: null });
    await anonymousSignInInFlight?.catch(() => undefined);
    const result = await signUpWithEmail(email, password, name);
    if (result.error || !result.user) {
      set({ isLoading: false, error: result.error || 'Sign up failed' });
      return;
    }
    await applyAuthenticatedSession(set, result, name || email.split('@')[0]);
  },

  signInWithGoogle: async () => {
    set({ isLoading: true, loadingProvider: 'google', error: null });
    await anonymousSignInInFlight?.catch(() => undefined);
    await applyOAuthResult(set, await signInWithGoogleApi());
  },

  signInWithApple: async () => {
    set({ isLoading: true, loadingProvider: 'apple', error: null });
    await anonymousSignInInFlight?.catch(() => undefined);
    await applyOAuthResult(set, await signInWithAppleApi());
  },

  signInWithMicrosoft: async () => {
    set({ isLoading: true, loadingProvider: 'microsoft', error: null });
    await anonymousSignInInFlight?.catch(() => undefined);
    await applyOAuthResult(set, await signInWithMicrosoftApi());
  },

  continueAsGuest: async () => {
    set({ isLoading: true });
    try {
      await anonymousSignInInFlight?.catch(() => undefined);
      await clearSession();
      await SecureStore.setItemAsync(GUEST_SESSION_KEY, 'true');
      useUsageStore.getState().reset();
      set({ user: null, sessionCookie: null, isGuest: true, error: null });
    } finally {
      set({ isLoading: false });
    }
  },

  // Skips anyone who already chose "continue without an account" on a previous
  // build. Silently creating a server-side record for someone who declined one
  // is a consent question, not a plumbing detail — they keep the on-device
  // experience they opted into.
  ensureAnonymousSession: async () => {
    const { user, isGuest, isInitialized, isLoading } = useAuthStore.getState();
    if (!isInitialized || user || isGuest || isLoading) return;
    // The store check above can't dedupe concurrent callers, since `user` is
    // only set after the round trip — and each extra call would leave behind a
    // real, orphaned user row on the server.
    if (anonymousSignInInFlight) return anonymousSignInInFlight;

    anonymousSignInInFlight = (async () => {
      const result = await signInAnonymously();
      if (!result.user) {
        // This session is load-bearing for cloud transcription, usage limits
        // and the paywall for the whole first run, so a refusal the server
        // sent (route missing after a bad deploy, plugin off, rate limited)
        // must be loud. No response, or a 5xx, is the offline-at-first-launch
        // case the foreground retry exists for; it must not read as an outage.
        const refused = result.status !== null && result.status < 500;
        Sentry.captureMessage('Anonymous session could not be created', {
          level: refused ? 'error' : 'warning',
          tags: { feature: 'onboarding-auth' },
          extra: { reason: result.error ?? 'no user returned' },
        });
        return;
      }

      // Deliberately skips initAuthenticatedUser: the server bootstraps this
      // user on its first authenticated request, and there is no real address
      // to send a welcome or verification email to yet.
      set({ user: result.user, sessionCookie: result.sessionCookie, isGuest: false });
    })().finally(() => {
      anonymousSignInInFlight = null;
    });

    return anonymousSignInInFlight;
  },

  signOut: async () => {
    set({ isLoading: true });
    await anonymousSignInInFlight?.catch(() => undefined);
    await signOutApi();
    await SecureStore.deleteItemAsync(GUEST_SESSION_KEY);
    useUsageStore.getState().reset();
    clearAgentSessions();
    set({ user: null, sessionCookie: null, isGuest: false, isLoading: false });
  },

  deleteAccount: async () => {
    set({ isLoading: true, error: null });
    await anonymousSignInInFlight?.catch(() => undefined);
    try {
      await deleteAccountApi();
      await clearSession();
      await SecureStore.deleteItemAsync(GUEST_SESSION_KEY);
      useUsageStore.getState().reset();
      clearAgentSessions();
      set({ user: null, sessionCookie: null, isGuest: false, isLoading: false });
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : 'Delete failed' });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));

type SetState = StoreApi<AuthStore>['setState'];

async function applyAuthenticatedSession(
  set: SetState,
  result: SessionResult,
  fallbackName?: string,
): Promise<void> {
  await SecureStore.deleteItemAsync(GUEST_SESSION_KEY);
  await initAuthenticatedUser(result.user, fallbackName);
  useUsageStore.getState().reset();
  set({
    user: result.user,
    sessionCookie: result.sessionCookie,
    isGuest: false,
    isLoading: false,
    loadingProvider: null,
    error: result.error ?? null,
  });
}

async function applyOAuthResult(set: SetState, result: SocialAuthResult): Promise<void> {
  if (!result.success) {
    set({ isLoading: false, loadingProvider: null, error: result.error || null });
    return;
  }
  const user = result.sessionCookie ? await getSession() : null;
  await applyAuthenticatedSession(set, { user, sessionCookie: result.sessionCookie });
}
