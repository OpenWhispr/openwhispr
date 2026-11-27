/**
 * Remembers, for this run of the app, the email an account was just created for on this phone.
 *
 * Signing up switches the app to the new account, and Root rebuilds every screen for it (its Stack is
 * keyed by the account), so the sign-in screen mounts again with fresh state. Kept here, the sign-up
 * survives that rebuild, and Verify your email still shows the just-created version (6.1: "We sent a
 * link…", a resend countdown, Use a different email) instead of the one for an account left
 * unverified earlier (6.4). Keyed by email, so another account is never mistaken for it.
 */
let signedUpEmail: string | null = null;

const normalize = (email: string) => email.trim().toLowerCase();

export function rememberSignUp(email: string): void {
  signedUpEmail = normalize(email);
}

export function forgetSignUp(): void {
  signedUpEmail = null;
}

export function wasSignedUpHere(email: string | null | undefined): boolean {
  return !!email && signedUpEmail === normalize(email);
}
