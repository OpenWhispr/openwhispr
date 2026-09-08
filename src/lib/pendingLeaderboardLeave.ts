// Each account owns its own key so two renderer windows changing different
// accounts cannot lose either pending leave through shared read-modify-write state.
const PENDING_PREFIX = "leaderboardLeavePending:";

function accountKey(userId: string): string {
  return `${PENDING_PREFIX}${encodeURIComponent(userId)}`;
}

export function readPendingLeaderboardLeave(userId: string): boolean {
  try {
    return localStorage.getItem(accountKey(userId)) === "true";
  } catch {
    return false;
  }
}

export function writePendingLeaderboardLeave(userId: string): void {
  try {
    localStorage.setItem(accountKey(userId), "true");
  } catch {
    // Losing the record only costs the retry; the account preference is unchanged.
  }
}

export function clearPendingLeaderboardLeave(userId: string): void {
  try {
    localStorage.removeItem(accountKey(userId));
  } catch {
    // A failed clear only causes an idempotent leave retry.
  }
}
