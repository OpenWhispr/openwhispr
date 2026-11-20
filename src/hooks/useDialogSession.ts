import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  getAuthRequestContextSnapshot,
  getAuthRequestContextServerSnapshot,
  subscribeAuthRequestContext,
} from "../lib/authRequestContext";

export interface DialogCompletion {
  isCurrent: () => boolean;
  isAccountCurrent: () => boolean;
}

// Signing out and switching accounts always replace the credential generation.
// A failed session refetch keeps the generation: a network failure clears only the
// validation, and an HTTP failure other than 401 also clears the session's user. So
// the generation alone binds the account, and a pending create still lands its result.
function accountBinding() {
  return getAuthRequestContextSnapshot().observedGeneration;
}

/** Dialog-local completion expires on dismissal; completed writes still reconcile for their account. */
export function useDialogSession(open: boolean, owner = "") {
  const auth = useSyncExternalStore(
    subscribeAuthRequestContext,
    getAuthRequestContextSnapshot,
    getAuthRequestContextServerSnapshot
  );
  // A credential change resets the session; a failed session refetch at the same
  // generation does not. capture() still checks the account binding.
  const sessionKey = JSON.stringify([open, owner, auth.observedGeneration]);
  const session = useRef<object | null>(null);
  // The committed form owns the session. Ref replacement/cleanup also fences
  // external close, account/resource changes and StrictMode replay.
  const bindSession = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !open) return;
      const current = {};
      session.current = current;
      return () => {
        if (session.current === current) session.current = null;
      };
    },
    [open, sessionKey]
  );
  const invalidate = useCallback(() => {
    session.current = null;
  }, []);
  const capture = useCallback(() => {
    const current = session.current;
    const account = accountBinding();
    const isAccountCurrent = () => accountBinding() === account;
    return {
      isAccountCurrent,
      isCurrent: () => current !== null && session.current === current && isAccountCurrent(),
    };
  }, []);
  return { sessionKey, capture, invalidate, bindSession };
}
