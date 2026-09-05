// Leaves the user already asked for that have not reached the account yet, one
// entry per account. Tagged with the account that asked, so the retry can only
// ever take that account off a leaderboard — never put a different one on — and
// held as a set, so a second account signing in and leaving cannot discard the
// opt-out the first one is still waiting to deliver.
const KEY = "leaderboardLeavePendingUserIds";

function readPendingUserIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writePendingUserIds(userIds: string[]): void {
  try {
    if (userIds.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(userIds));
  } catch {
    // Losing the record only costs the retry; the account preference is unchanged.
  }
}

export function readPendingLeaderboardLeave(userId: string): boolean {
  return readPendingUserIds().includes(userId);
}

export function writePendingLeaderboardLeave(userId: string): void {
  const pending = readPendingUserIds();
  if (!pending.includes(userId)) writePendingUserIds([...pending, userId]);
}

export function clearPendingLeaderboardLeave(userId: string): void {
  const pending = readPendingUserIds();
  if (pending.includes(userId)) writePendingUserIds(pending.filter((id) => id !== userId));
}
