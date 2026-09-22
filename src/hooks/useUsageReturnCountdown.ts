import { useEffect, useState } from "react";
import { getUsageReturnCountdown } from "../lib/usagePresentation";

const TICK_MS = 60_000;

export function useUsageReturnCountdown(
  availableAt: number | null,
  onRefresh: () => Promise<void>
) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (availableAt === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime < availableAt) {
        timer = setTimeout(tick, Math.min(TICK_MS, availableAt - currentTime));
      } else {
        void onRefresh();
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [availableAt, onRefresh]);

  return getUsageReturnCountdown(availableAt, now);
}
