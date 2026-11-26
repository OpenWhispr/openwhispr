import { useAuthStore } from '@/store/useAuthStore';
import { isAccountLink } from '@/sync/syncIdentity';

/**
 * Remembers which account a meeting belongs to, so the steps that run after Stop (title and
 * summary generation, speaker matching against voice profiles, cloud transcription) can tell the
 * account changed mid-processing and skip anything that would use the new account's credentials
 * or data on the old account's transcript. `null` is a signed-out or guest session: someone
 * signing in mid-processing is a change too. An anonymous session signing up is not: sync keeps
 * its rows for the account it became (isAccountLink), so the fence follows it to that account.
 */
export interface MeetingAccountFence {
  readonly accountId: string | null;
  isCurrent: () => boolean;
}

const currentAccountId = (): string | null => useAuthStore.getState().user?.id ?? null;

export function captureMeetingAccount(): MeetingAccountFence {
  return meetingAccountFenceFor(currentAccountId());
}

/** A fence for an owner saved earlier, possibly by a process that has since been killed. */
export function meetingAccountFenceFor(savedOwner: string | null): MeetingAccountFence {
  let owner = savedOwner;
  return {
    get accountId(): string | null {
      return owner;
    },
    isCurrent: (): boolean => {
      const now = currentAccountId();
      if (now === owner) return true;
      if (owner == null || now == null || !isAccountLink(owner, now)) return false;
      owner = now;
      return true;
    },
  };
}
