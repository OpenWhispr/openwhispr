/**
 * The OpenWhispr cloud account system has been removed. This file now exports
 * stubs so cloud-account-gated call sites keep compiling. Calls that would
 * have hit the auth backend now fail with AUTH_REMOVED, which surfaces as a
 * normal error to the caller.
 */

export const AUTH_URL = "";

function authRemovedError(): Error {
  const err = new Error("OpenWhispr account features have been removed.");
  Object.assign(err, { code: "AUTH_REMOVED" });
  return err;
}

export function isWithinGracePeriod(): boolean {
  return false;
}

export function updateLastSignInTime(): void {}

export async function deleteAccount(): Promise<{ error?: Error }> {
  return { error: authRemovedError() };
}

export async function signOut(): Promise<void> {
  // No-op — there is no session to clear.
}

export async function withSessionRefresh<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

export type SocialProvider = "google" | "microsoft" | "apple";

export async function signInWithSocial(): Promise<{ error?: Error }> {
  return { error: authRemovedError() };
}

export async function requestPasswordReset(): Promise<{ error?: Error }> {
  return { error: authRemovedError() };
}

// Minimal authClient shim so accidental imports don't crash. All operations
// reject with AUTH_REMOVED.
const reject = async () => {
  throw authRemovedError();
};

export const authClient = {
  signIn: { email: reject, social: reject },
  signUp: { email: reject },
  signOut: reject,
  requestPasswordReset: reject,
  useSession: () => ({ data: null, isPending: false, error: null, refetch: reject }),
} as const;
