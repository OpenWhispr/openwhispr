/**
 * Auth has been removed in favor of the Corti PKCE flow (see CortiOAuth /
 * Settings → Corti). The remaining `useAuth` hook is a stub that keeps the
 * many call sites compiling — every consumer behaves as if the user is
 * "signed out" of the legacy OpenWhispr account system. Cloud-account-gated
 * features (workspace, billing, share, sync) silently degrade.
 */
interface StubUser {
  id?: string;
  name?: string;
  email?: string;
  image?: string;
}

export function useAuth() {
  return {
    isSignedIn: false,
    isGracePeriodOnly: false,
    isLoaded: true,
    session: null as { user?: StubUser } | null,
    user: null as StubUser | null,
  };
}
