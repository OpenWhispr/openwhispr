import { useSettingsStore } from "../stores/settingsStore";

export type CalendarProvider = "google" | "microsoft" | "apple";

/** cancelled: the user backed out on the consent screen. denied: macOS refused Calendar access. */
export type CalendarConnectResult = "connected" | "cancelled" | "denied" | "failed";

// access_denied means the user cancelled on the consent screen.
const oauthFailure = (error?: string): CalendarConnectResult =>
  error?.includes("access_denied") ? "cancelled" : "failed";

/** Runs a provider's sign-in or permission flow and records the account in settings. */
export async function connectCalendar(provider: CalendarProvider): Promise<CalendarConnectResult> {
  const store = useSettingsStore.getState();
  if (provider === "google") {
    const result = await window.electronAPI?.gcalStartOAuth?.();
    if (!result?.success || !result.email) return oauthFailure(result?.error);
    store.setGcalAccounts([
      ...useSettingsStore.getState().gcalAccounts.filter((a) => a.email !== result.email),
      { email: result.email },
    ]);
    return "connected";
  }
  if (provider === "microsoft") {
    const result = await window.electronAPI?.mcalStartOAuth?.();
    if (!result?.success || !result.email) return oauthFailure(result?.error);
    store.setMcalAccounts([
      ...useSettingsStore.getState().mcalAccounts.filter((a) => a.email !== result.email),
      { email: result.email, tenantId: result.tenantId },
    ]);
    return "connected";
  }
  const result = await window.electronAPI?.acalConnect?.();
  if (result?.success) {
    store.setAppleCalendarConnected(true);
    return "connected";
  }
  // Only a real permission denial is one; a missing helper or a failed snapshot is not.
  return result?.reason === "denied" ? "denied" : "failed";
}
