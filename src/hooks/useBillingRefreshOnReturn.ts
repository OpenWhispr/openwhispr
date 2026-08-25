import { useCallback, useRef } from "react";

const POLL_DELAYS_MS = [4000, 8000, 16000];

let cancelWatch: (() => void) | null = null;

/**
 * Post-checkout/portal refresh: billing happens in the external browser, so
 * the next window focus is the earliest signal the user may be done. Refresh
 * immediately on focus, then re-poll on a short backoff while Stripe's
 * webhook lands. The watch lives at module scope so it survives the arming
 * component unmounting while the user is off in Stripe; arming again from
 * anywhere cancels the previous watch (one pending watch at a time).
 */
export function armBillingRefreshOnReturn(refresh: () => void): void {
  cancelWatch?.();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const onFocus = () => {
    refresh();
    for (const delayMs of POLL_DELAYS_MS) timers.push(setTimeout(refresh, delayMs));
  };
  window.addEventListener("focus", onFocus, { once: true });
  cancelWatch = () => {
    window.removeEventListener("focus", onFocus);
    timers.forEach(clearTimeout);
  };
}

/** Component wrapper: the armed watch always calls the latest render's callback. */
export function useBillingRefreshOnReturn(refresh: () => void): () => void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  return useCallback(() => armBillingRefreshOnReturn(() => refreshRef.current()), []);
}
