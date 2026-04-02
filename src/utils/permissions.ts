/** Returns true when all required OS permissions are granted. */
export function areRequiredPermissionsMet(micGranted: boolean): boolean {
  if (!micGranted) return false;

  // Accessibility is no longer required — falls back to clipboard-only mode.
  // Previously hard-blocked onboarding with stale TCC entries (#394).
  return true;
}
