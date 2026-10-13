// Stored rather than kept in memory: signing in always crosses a reload, both here
// and again for Google, Microsoft, Apple and SSO (applySessionTokenAndRefresh in main.js).
export const SIGN_IN_PROMPTED_AT_KEY = "signInPromptedAt";

/**
 * Logs a guest out instead of restarting onboarding.
 *
 * Every signed-out "sign in" button used to reset onboarding progress (#2128), and
 * re-walking the wizard rewrote the provider setup the user had configured. Dropping
 * the guest flag leaves onboarding finished, so AppRouter routes to the same
 * reauthentication screen a signed-out account already gets, with every setting intact.
 * Its "Continue without an account" writes the flag back.
 */
export function requestSignIn(): void {
  localStorage.setItem(SIGN_IN_PROMPTED_AT_KEY, String(Date.now()));
  localStorage.removeItem("authenticationSkipped");
  localStorage.removeItem("skipAuth");
  window.location.reload();
}
