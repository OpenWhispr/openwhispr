// Leaves the user already asked for that have not reached the account yet.
// Each account owns its own key so two renderer windows changing different
// accounts cannot lose either intent through a shared read-modify-write array.
const LEGACY_KEY = "leaderboardLeavePendingUserIds";
const PENDING_PREFIX = "leaderboardLeavePending:";
const RESOLVED_PREFIX = "leaderboardLeaveResolved:";

function accountKey(prefix: string, userId: string): string {
  return `${prefix}${encodeURIComponent(userId)}`;
}

function legacyPendingIncludes(userId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "[]");
    return Array.isArray(parsed) && parsed.includes(userId);
  } catch {
    return false;
  }
}

export function readPendingLeaderboardLeave(userId: string): boolean {
  try {
    const pendingKey = accountKey(PENDING_PREFIX, userId);
    const resolvedKey = accountKey(RESOLVED_PREFIX, userId);
    if (localStorage.getItem(resolvedKey) === "true") return false;
    if (localStorage.getItem(pendingKey) === "true") return true;
    if (!legacyPendingIncludes(userId)) return false;

    // Adopt the old shared-array record lazily. A per-account resolved marker
    // lets clear remain atomic without rewriting that legacy array.
    localStorage.setItem(pendingKey, "true");
    return true;
  } catch {
    return false;
  }
}

export function writePendingLeaderboardLeave(userId: string): void {
  try {
    localStorage.removeItem(accountKey(RESOLVED_PREFIX, userId));
    localStorage.setItem(accountKey(PENDING_PREFIX, userId), "true");
  } catch {
    // Losing the record only costs the retry; the account preference is unchanged.
  }
}

export function clearPendingLeaderboardLeave(userId: string): void {
  try {
    localStorage.removeItem(accountKey(PENDING_PREFIX, userId));
    // Suppress a migrated legacy entry without rewriting shared state. A new
    // Leave removes this marker before installing its own pending key.
    const resolvedKey = accountKey(RESOLVED_PREFIX, userId);
    if (legacyPendingIncludes(userId)) localStorage.setItem(resolvedKey, "true");
    else localStorage.removeItem(resolvedKey);
  } catch {
    // A failed clear only causes an idempotent leave retry.
  }
}
