import { useEffect, useRef, useState } from "react";
import { getUsageReturnCountdown } from "../lib/usagePresentation";

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
const FOCUS_RETRY_DELAY_MS = 60_000;

interface RefreshState {
  deadline: number;
  attempts: number;
  nextAttemptAt: number;
  pending: Promise<void> | null;
}

export function useUsageReturnCountdown(
  availableAt: string | null,
  onRefresh: () => Promise<void>
) {
  const [now, setNow] = useState(Date.now);
  const refreshState = useRef<RefreshState | null>(null);
  const deadline = Date.parse(availableAt ?? "");

  useEffect(() => {
    if (!Number.isFinite(deadline)) {
      refreshState.current = null;
      return;
    }
    if (refreshState.current?.deadline !== deadline) {
      refreshState.current = { deadline, attempts: 0, nextAttemptAt: 0, pending: null };
    }
    const refresh = refreshState.current;

    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const update = (fromFocus = false) => {
      if (disposed) return;
      clearTimeout(timer);
      const currentTime = Date.now();
      setNow(currentTime);
      if (deadline <= currentTime) {
        if (refresh.pending) return;
        const canRetryAutomatically = refresh.attempts <= RETRY_DELAYS_MS.length;
        if (currentTime >= refresh.nextAttemptAt && (canRetryAutomatically || fromFocus)) {
          const delay = RETRY_DELAYS_MS[refresh.attempts] ?? FOCUS_RETRY_DELAY_MS;
          refresh.attempts += 1;
          const complete = () => {
            refresh.pending = null;
            refresh.nextAttemptAt = Date.now() + delay;
            update();
          };
          refresh.pending = onRefresh().then(complete, complete);
        } else if (canRetryAutomatically) {
          timer = setTimeout(update, refresh.nextAttemptAt - currentTime);
        }
        return;
      }
      timer = setTimeout(update, Math.min(60_000, deadline - currentTime));
    };

    // An unchanged timestamp can reflect clock skew. Retry briefly, then only
    // on a throttled wake/focus event, without overlapping an existing request.
    const pendingRefresh = refresh.pending;
    update();
    void pendingRefresh?.then(() => update());
    const handleFocus = () => update(true);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [deadline, onRefresh]);

  return getUsageReturnCountdown(availableAt, now);
}
