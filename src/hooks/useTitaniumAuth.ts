import { useCallback, useSyncExternalStore } from "react";
import type { TitaniumAuthState } from "../types/electron";

// Titanium sign-in state shared by every component in a window. The main process owns
// the session (src/helpers/titanium/titaniumSession.js); this store mirrors it from the
// titanium-auth-changed broadcast. Separate from useAuth on purpose: useAuth is the
// OpenWhispr cloud session, which stays signed out in this fork.

const SIGNED_OUT: TitaniumAuthState = {
  configured: false,
  signedIn: false,
  accountBound: false,
  email: null,
  signedInAt: null,
  licensed: false,
  license: null,
  reason: "signed_out",
  pending: false,
  error: null,
};

let current: TitaniumAuthState = SIGNED_OUT;
let started = false;
const listeners = new Set<() => void>();

function publish(next: TitaniumAuthState) {
  current = next;
  for (const listener of listeners) listener();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const api = window.electronAPI;
  api?.onTitaniumAuthChanged?.(publish);
  void api
    ?.titaniumAuthGetState?.()
    .then((state) => state && publish(state))
    .catch(() => undefined);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTitaniumAuthState(): TitaniumAuthState {
  start();
  return current;
}

export function useTitaniumAuth() {
  const state = useSyncExternalStore(subscribe, getTitaniumAuthState, () => SIGNED_OUT);
  const signIn = useCallback(async () => {
    const result = await window.electronAPI?.titaniumAuthSignIn?.();
    return result ?? { started: false, error: "unavailable" };
  }, []);
  const signOut = useCallback(async () => {
    const next = await window.electronAPI?.titaniumAuthSignOut?.();
    if (next) publish(next);
  }, []);
  return { ...state, signIn, signOut };
}
