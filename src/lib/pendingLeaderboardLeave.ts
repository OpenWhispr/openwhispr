// Each account owns its own key so two renderer windows changing different
// accounts cannot lose either pending leave through shared read-modify-write state.
const PENDING_PREFIX = "leaderboardLeavePending:";

// A leave the network never delivered keeps its place forever — the account
// asked to come off a leaderboard and only a delivered PATCH may retire that.
// Its claim on *priority* is what expires: SyncService lets a pending leave
// bypass the sync throttle, the in-flight guard and the ambient backoff, so a
// leave that can never land would otherwise run an unthrottled full pass on
// every focus, visibility change and online event for the life of the install.
// After this many failed deliveries the record stays and keeps retrying on
// ordinary passes, without commandeering them.
export const MAX_PRIORITY_LEAVE_ATTEMPTS = 5;

interface PendingLeave {
  attempts: number;
}

function accountKey(userId: string): string {
  return `${PENDING_PREFIX}${encodeURIComponent(userId)}`;
}

function readPendingLeave(userId: string): PendingLeave | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(accountKey(userId));
  } catch {
    return null;
  }
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const attempts = (parsed as { attempts?: unknown }).attempts;
      if (typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0) {
        return { attempts };
      }
    }
  } catch {
    // Builds before the attempt bound stored a bare "true", which is not JSON.
  }
  // A legacy or half-written value is still an account waiting to leave; only
  // its attempt count is unknown, and restarting the count costs at most a few
  // prioritized passes.
  return { attempts: 0 };
}

function writePendingLeave(userId: string, attempts: number): void {
  try {
    localStorage.setItem(accountKey(userId), JSON.stringify({ attempts }));
  } catch {
    // Losing the record only costs the retry; the account preference is unchanged.
  }
}

export function readPendingLeaderboardLeave(userId: string): boolean {
  return readPendingLeave(userId) !== null;
}

/**
 * Whether a pending leave may still preempt the sync throttle. Separate from
 * {@link readPendingLeaderboardLeave} so an undeliverable leave keeps being
 * retried without holding the throttle open — see MAX_PRIORITY_LEAVE_ATTEMPTS.
 */
export function pendingLeaderboardLeaveDeservesPriority(userId: string): boolean {
  const pending = readPendingLeave(userId);
  return pending !== null && pending.attempts < MAX_PRIORITY_LEAVE_ATTEMPTS;
}

export function writePendingLeaderboardLeave(userId: string): void {
  writePendingLeave(userId, 0);
}

/** Records one undelivered attempt, retiring the record's priority in time. */
export function recordPendingLeaderboardLeaveAttempt(userId: string): void {
  const pending = readPendingLeave(userId);
  if (pending === null || pending.attempts >= MAX_PRIORITY_LEAVE_ATTEMPTS) return;
  writePendingLeave(userId, pending.attempts + 1);
}

export function clearPendingLeaderboardLeave(userId: string): void {
  try {
    localStorage.removeItem(accountKey(userId));
  } catch {
    // A failed clear only causes an idempotent leave retry.
  }
}
