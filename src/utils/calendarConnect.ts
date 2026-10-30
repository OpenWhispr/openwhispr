import { useSettingsStore } from "../stores/settingsStore";
import { subscribeAuthBoundary } from "../lib/authRequestContext";

export type CalendarProvider = "google" | "microsoft" | "apple";

/** cancelled: the user backed out on the consent screen. denied: macOS refused Calendar access. */
export type CalendarConnectResult = "connected" | "cancelled" | "denied" | "failed";

// access_denied means the user cancelled on the consent screen.
const oauthFailure = (error?: string): CalendarConnectResult =>
  error?.includes("access_denied") || error === "oauth_cancelled" ? "cancelled" : "failed";

/** Runs a provider's sign-in or permission flow and records the account in settings. */
export async function connectCalendar(
  provider: CalendarProvider,
  signal?: AbortSignal
): Promise<CalendarConnectResult> {
  const controller = new AbortController();
  const currentSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const unsubscribe = subscribeAuthBoundary(() => controller.abort());
  const requestId = crypto.randomUUID();
  const cancel = () => void window.electronAPI?.calendarCancelConnect?.(requestId);
  if (currentSignal.aborted) {
    unsubscribe();
    return "cancelled";
  }
  currentSignal.addEventListener("abort", cancel, { once: true });
  try {
    const store = useSettingsStore.getState();
    if (provider === "google") {
      const result = await window.electronAPI?.gcalStartOAuth?.(requestId);
      if (currentSignal.aborted) return "cancelled";
      if (!result?.success || !result.email) return oauthFailure(result?.error);
      store.setGcalAccounts([
        ...useSettingsStore.getState().gcalAccounts.filter((a) => a.email !== result.email),
        { email: result.email },
      ]);
      return "connected";
    }
    if (provider === "microsoft") {
      const result = await window.electronAPI?.mcalStartOAuth?.(requestId);
      if (currentSignal.aborted) return "cancelled";
      if (!result?.success || !result.email) return oauthFailure(result?.error);
      store.setMcalAccounts([
        ...useSettingsStore.getState().mcalAccounts.filter((a) => a.email !== result.email),
        { email: result.email, tenantId: result.tenantId },
      ]);
      return "connected";
    }
    const result = await window.electronAPI?.acalConnect?.(requestId);
    if (currentSignal.aborted || result?.reason === "cancelled") return "cancelled";
    if (result?.success) {
      store.setAppleCalendarConnected(true);
      return "connected";
    }
    // Only a real permission denial is one; a missing helper or a failed snapshot is not.
    return result?.reason === "denied" ? "denied" : "failed";
  } finally {
    unsubscribe();
    currentSignal.removeEventListener("abort", cancel);
  }
}
