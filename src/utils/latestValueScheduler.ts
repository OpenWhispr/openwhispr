export interface LatestValueScheduler<T> {
  push: (value: T, options?: { immediate?: boolean }) => void;
  flush: () => void;
  cancel: () => void;
}

interface SchedulerClock {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultClock: SchedulerClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

/**
 * Commits the first value immediately, then keeps only the newest value inside
 * each interval. Realtime providers can emit several cumulative transcript
 * deltas per frame; rendering the superseded intermediate values only adds
 * layout and IPC work without making the preview more current.
 */
export function createLatestValueScheduler<T>(
  commit: (value: T) => void,
  intervalMs: number,
  clock: SchedulerClock = defaultClock
): LatestValueScheduler<T> {
  const safeIntervalMs = Math.max(0, intervalMs);
  let lastCommitAt = Number.NEGATIVE_INFINITY;
  let pendingValue: T;
  let hasPendingValue = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearScheduledTimer = () => {
    if (timer === null) return;
    clock.clearTimer(timer);
    timer = null;
  };

  const flush = () => {
    clearScheduledTimer();
    if (!hasPendingValue) return;

    const value = pendingValue;
    hasPendingValue = false;
    lastCommitAt = clock.now();
    commit(value);
  };

  const push = (value: T, options: { immediate?: boolean } = {}) => {
    pendingValue = value;
    hasPendingValue = true;

    if (options.immediate) {
      flush();
      return;
    }

    const elapsedMs = clock.now() - lastCommitAt;
    if (elapsedMs >= safeIntervalMs) {
      flush();
      return;
    }

    if (timer === null) {
      timer = clock.setTimer(flush, safeIntervalMs - elapsedMs);
    }
  };

  const cancel = () => {
    clearScheduledTimer();
    hasPendingValue = false;
  };

  return { push, flush, cancel };
}
