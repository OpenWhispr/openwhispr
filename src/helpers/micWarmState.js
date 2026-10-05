// Warm state is a timestamp, not a latch: mic drivers go cold again after idle,
// so a permanent "warmed" flag would never re-warm a driver that has since slept.
export const MIC_WARM_TTL_MS = 5000;

// Deadline for a warm-up acquisition, deliberately independent of the TTL: the
// cold-open worst case documented in audioManager is 10-15s, and a machine that
// slow is exactly the one whose eventual success must still be recorded as warm.
export const WARMUP_ACQUIRE_TIMEOUT_MS = 15000;

// True only when the mic was warmed within the TTL. A negative elapsed (clock
// jumped backwards) returns false so we err on the side of re-warming.
export const isMicWarm = (lastWarmedAt, now, ttlMs = MIC_WARM_TTL_MS) => {
  if (typeof lastWarmedAt !== "number" || lastWarmedAt <= 0) return false;
  const elapsed = now - lastWarmedAt;
  return elapsed >= 0 && elapsed < ttlMs;
};
