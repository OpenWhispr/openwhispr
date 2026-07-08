export function armMaxRecordingDurationTimer(
  maxDurationSec: number,
  onLimit: () => void
): (() => void) | null {
  if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0) return null;
  const delayMs = maxDurationSec * 1000;
  // Delays past the 32-bit setTimeout cap would fire immediately; treat them as no limit.
  if (delayMs > 2147483647) return null;
  const timer = setTimeout(onLimit, delayMs);
  return () => clearTimeout(timer);
}
