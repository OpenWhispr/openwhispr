import { useEffect, useRef, useState } from "react";
import { getUsageReturnCountdown } from "../lib/usagePresentation";

export function useUsageReturnCountdown(
  availableAt: string | null,
  onRefresh: () => Promise<void>
) {
  const [now, setNow] = useState(Date.now);
  const refreshedAt = useRef<number | null>(null);
  const deadline = Date.parse(availableAt ?? "");

  useEffect(() => {
    if (!Number.isFinite(deadline)) return;

    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const currentTime = Date.now();
      setNow(currentTime);
      if (deadline <= currentTime) {
        // A stale response must not start an automatic refetch loop.
        if (refreshedAt.current !== deadline) {
          refreshedAt.current = deadline;
          void onRefresh();
        }
        return;
      }
      timer = setTimeout(update, Math.min(60_000, deadline - currentTime));
    };

    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [deadline, onRefresh]);

  return getUsageReturnCountdown(availableAt, now);
}
