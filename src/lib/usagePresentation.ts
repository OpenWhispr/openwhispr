const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function getUsagePercentage(wordsUsed: number, limit: number): number | null {
  if (limit <= 0) return null;
  return Math.min(100, (wordsUsed * 100) / limit);
}

export function getUsageReturnCountdown(availableAt: number | null, now: number) {
  if (availableAt === null || availableAt <= now) return null;
  const remaining = availableAt - now;
  if (remaining >= DAY) return { unit: "day" as const, count: Math.ceil(remaining / DAY) };
  if (remaining >= HOUR) return { unit: "hour" as const, count: Math.ceil(remaining / HOUR) };
  return { unit: "minute" as const, count: Math.ceil(remaining / MINUTE) };
}
