const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function getUsagePercentage(wordsUsed: number, limit: number): number | null {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(wordsUsed)) return null;
  return Math.min(100, Math.max(0, (wordsUsed / limit) * 100));
}

export function getUsageReturnCountdown(availableAt: string | null, now: number) {
  const remaining = Date.parse(availableAt ?? "") - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  if (remaining >= DAY) return { unit: "day" as const, count: Math.ceil(remaining / DAY) };
  if (remaining >= HOUR) return { unit: "hour" as const, count: Math.ceil(remaining / HOUR) };
  return { unit: "minute" as const, count: Math.ceil(remaining / MINUTE) };
}
