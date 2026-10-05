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
