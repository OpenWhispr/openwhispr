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
