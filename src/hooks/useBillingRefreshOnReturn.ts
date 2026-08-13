import { useCallback, useEffect, useRef } from "react";

const POLL_DELAYS_MS = [4000, 8000, 16000];

/**
 * Post-checkout/portal refresh: billing happens in the external browser, so
 * the next window focus is the earliest signal the user may be done. Refresh
 * immediately on focus, then re-poll on a short backoff while Stripe's
 * webhook lands. Returns an arm() function; re-arming cancels the previous
 * watch and unmount cleans up automatically.
 */
export function useBillingRefreshOnReturn(refresh: () => void): () => void {
  const cleanupRef = useRef<(() => void) | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback(() => {
    cleanupRef.current?.();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const poll = () => refreshRef.current();
    const onFocus = () => {
      poll();
      for (const delayMs of POLL_DELAYS_MS) timers.push(setTimeout(poll, delayMs));
    };
    window.addEventListener("focus", onFocus, { once: true });
    cleanupRef.current = () => {
      window.removeEventListener("focus", onFocus);
      timers.forEach(clearTimeout);
    };
  }, []);
}
