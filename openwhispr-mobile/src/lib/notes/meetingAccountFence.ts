import { useAuthStore } from '@/store/useAuthStore';

/**
 * Remembers which account a meeting belongs to, so the steps that run after Stop (title and
 * summary generation, speaker matching against voice profiles, cloud transcription) can tell the
 * account changed mid-processing and skip anything that would use the new account's credentials
 * or data on the old account's transcript. `null` is a signed-out or guest session: someone
 * signing in mid-processing is a change too.
 */
export interface MeetingAccountFence {
  readonly accountId: string | null;
  isCurrent: () => boolean;
}

const currentAccountId = (): string | null => useAuthStore.getState().user?.id ?? null;

export function captureMeetingAccount(): MeetingAccountFence {
  const accountId = currentAccountId();
  return { accountId, isCurrent: () => currentAccountId() === accountId };
}
