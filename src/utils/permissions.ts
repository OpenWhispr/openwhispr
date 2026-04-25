/** Returns true when all required OS permissions are granted. */
export function areRequiredPermissionsMet(micGranted: boolean): boolean {
  if (!micGranted) return false;

  // Accessibility is no longer required — falls back to clipboard-only mode.
  // Previously hard-blocked onboarding with stale TCC entries (#394).
  return true;
}

/** Set when the user proceeds past macOS Accessibility without granting. Silences the nag and enables clipboard-only paste. */
export const ACCESSIBILITY_SKIPPED_KEY = "accessibilitySkipped";

export function isAccessibilitySkipped(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ACCESSIBILITY_SKIPPED_KEY) === "true";
}

/** Set once the user completes or permanently dismisses the 1.6.11 TCC re-grant modal. Suppresses re-showing it and other accessibility nags while the migration is pending. */
export const TCC_RESET_MODAL_SEEN_KEY = "tccResetModalSeen_1_6_11";

export function isTccResetModalSeen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(TCC_RESET_MODAL_SEEN_KEY) === "true";
}
