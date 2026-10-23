import type { AccountScopeAction } from "./authAccountScope";
import type { OfflineAccount } from "./authRequestContext";

// The display fields of the last validated account, so an offline launch can
// present it (Better Auth keeps the user only in memory). Read only for the
// account main's token-bound binding names, and cleared with the rest of the
// account's renderer caches.
export const OFFLINE_ACCOUNT_PROFILE_KEY = "openwhispr:accountProfile";
export const OFFLINE_ACCOUNT_PROFILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface OfflineAccountProfile {
  id: string;
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
}

interface StoredProfile extends OfflineAccountProfile {
  validatedAt: number;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function toProfile(user: unknown): OfflineAccountProfile | null {
  if (!user || typeof user !== "object") return null;
  const { id, name, email, image, emailVerified } = user as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    name: typeof name === "string" ? name : "",
    email: typeof email === "string" ? email : "",
    image: typeof image === "string" && image ? image : null,
    emailVerified: emailVerified === true,
  };
}

export function writeOfflineAccountProfile(user: unknown, now = Date.now()): void {
  const profile = toProfile(user);
  if (!profile) return;
  try {
    storage()?.setItem(
      OFFLINE_ACCOUNT_PROFILE_KEY,
      JSON.stringify({ ...profile, validatedAt: now } satisfies StoredProfile)
    );
  } catch {
    // Storage full or blocked: an offline launch then stays a guest.
  }
}

export function readOfflineAccountProfile(
  accountId: string | null,
  now = Date.now()
): OfflineAccountProfile | null {
  if (!accountId) return null;
  try {
    const raw = storage()?.getItem(OFFLINE_ACCOUNT_PROFILE_KEY);
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    const profile = toProfile(stored);
    const validatedAt = (stored as { validatedAt?: unknown }).validatedAt;
    if (!profile || profile.id !== accountId || typeof validatedAt !== "number") return null;
    const age = now - validatedAt;
    return age >= 0 && age <= OFFLINE_ACCOUNT_PROFILE_MAX_AGE_MS ? profile : null;
  } catch {
    return null;
  }
}

export function clearOfflineAccountProfile(): void {
  try {
    storage()?.removeItem(OFFLINE_ACCOUNT_PROFILE_KEY);
  } catch {
    // Nothing to clear if storage is unreachable.
  }
}

export interface OfflineAccountInput {
  isPending: boolean;
  sessionBound: boolean;
  offlineAccount: OfflineAccount | null;
  scopeAction: AccountScopeAction;
  profile: OfflineAccountProfile | null;
}

export interface PresentedOfflineAccount extends OfflineAccount {
  profile: OfflineAccountProfile;
}

/**
 * Present the binding's account only when the renderer's caches were last
 * reconciled for exactly that account and nothing is pending: a different
 * previous user, an unvalidated scope or an interrupted purge stays a guest
 * until a real get-session runs reconciliation.
 */
export function resolveOfflineAccount({
  isPending,
  sessionBound,
  offlineAccount,
  scopeAction,
  profile,
}: OfflineAccountInput): PresentedOfflineAccount | null {
  if (isPending || sessionBound || !offlineAccount) return null;
  if (scopeAction !== "none") return null;
  if (!profile || profile.id !== offlineAccount.userId) return null;
  return { ...offlineAccount, profile };
}
