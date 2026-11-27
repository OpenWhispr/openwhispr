import { notesRepository } from '@/data';

// Which identity the local rows belong to, kept in sync_state like the other
// per-device bookkeeping (teamSpacesCapability.ts, pullCursors.ts).
const LAST_USER_KEY = 'sync.user_id';
// The anonymous onboarding user whose rows are on this device. Signing up
// replaces that user's id, which would otherwise read as an account switch and
// wipe local data; this token turns that one transition into a link.
const ANONYMOUS_USER_KEY = 'sync.anonymous_user_id';

export function getLastSyncedUserId(): string | null {
  return notesRepository.getSyncState(LAST_USER_KEY);
}

export function setLastSyncedUserId(userId: string): void {
  notesRepository.setSyncState(LAST_USER_KEY, userId);
}

export function recordAnonymousUser(userId: string): void {
  notesRepository.setSyncState(ANONYMOUS_USER_KEY, userId);
}

/** True when the identity the rows last synced under is the anonymous user they were created by. */
export function isLinkFromAnonymous(lastUserId: string): boolean {
  return notesRepository.getSyncState(ANONYMOUS_USER_KEY) === lastUserId;
}

// Links made during this run of the app, from the anonymous id to the account it became. The
// token above is consumed by the sync run that links, so anything that started before the sign-up
// and asks afterwards (a meeting still being processed) needs the answer kept here.
const linkedAccounts = new Map<string, string>();

/** Called by the sync run that treated `fromUserId` → `toUserId` as a link (isLinkFromAnonymous). */
export function recordAccountLink(fromUserId: string, toUserId: string): void {
  linkedAccounts.set(fromUserId, toUserId);
}

/**
 * Whether the signed-in id changing from `previousUserId` to `nextUserId` is the same person
 * linking their anonymous session to an account, by the rule sync uses to keep their local rows
 * (isLinkFromAnonymous): either the run that linked already recorded it, or no run has yet and
 * the token still names the previous id, so the next run will link.
 */
export function isAccountLink(previousUserId: string, nextUserId: string): boolean {
  if (linkedAccounts.get(previousUserId) === nextUserId) return true;
  return !linkedAccounts.has(previousUserId) && isLinkFromAnonymous(previousUserId);
}

export function clearAnonymousLink(): void {
  notesRepository.clearSyncState(ANONYMOUS_USER_KEY);
}

/**
 * Whether a real account has synced on this device. Replaying onboarding
 * afterwards ("Reset onboarding") must not mint a new identity: the first sync
 * under it would read as an account switch and wipe that account's local rows.
 */
export function hasRealAccountHistory(): boolean {
  const lastUserId = getLastSyncedUserId();
  return lastUserId !== null && !isLinkFromAnonymous(lastUserId);
}
