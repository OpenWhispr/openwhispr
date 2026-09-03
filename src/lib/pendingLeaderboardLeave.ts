// A leave the user already asked for that has not reached the account yet.
// Tagged with the account that asked, so the retry can only ever take that
// account off a leaderboard — never put a different one on.
const KEY = "leaderboardLeavePendingUserId";

export function readPendingLeaderboardLeave(): string | null {
  return localStorage.getItem(KEY);
}

export function writePendingLeaderboardLeave(userId: string): void {
  localStorage.setItem(KEY, userId);
}

export function clearPendingLeaderboardLeave(userId: string): void {
  if (localStorage.getItem(KEY) === userId) localStorage.removeItem(KEY);
}
