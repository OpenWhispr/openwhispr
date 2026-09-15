import { create } from "zustand";

// Stored rather than kept in memory: Google, Microsoft, Apple and SSO sign-ins finish
// by reloading the control panel (applySessionTokenAndRefresh in main.js).
export const SIGN_IN_PROMPTED_AT_KEY = "signInPromptedAt";

interface SignInPromptState {
  open: boolean;
}

export const useSignInPromptStore = create<SignInPromptState>(() => ({ open: false }));

// Signs a guest in where they are. Restarting onboarding for this (#2128) sent them
// back through the whole wizard.
export function requestSignIn(): void {
  localStorage.setItem(SIGN_IN_PROMPTED_AT_KEY, String(Date.now()));
  useSignInPromptStore.setState({ open: true });
}

export function setSignInPromptOpen(open: boolean): void {
  useSignInPromptStore.setState({ open });
}
