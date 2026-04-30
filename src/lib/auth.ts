import { createAuthClient } from "better-auth/react";
import { OPENWHISPR_API_URL } from "../config/constants";
import { openExternalLink } from "../utils/externalLinks";
import logger from "../utils/logger";

export const AUTH_URL = import.meta.env.VITE_AUTH_URL || "https://auth.openwhispr.com";
export const authClient = createAuthClient({
  baseURL: AUTH_URL,
  fetchOptions: {
    headers: { "x-openwhispr-source": "desktop" },
  },
});

export type SocialProvider = "google" | "microsoft";

const LAST_SIGN_IN_STORAGE_KEY = "openwhispr:lastSignInTime";
const GRACE_PERIOD_MS = 60_000;
const GRACE_RETRY_COUNT = 6;
const INITIAL_GRACE_RETRY_DELAY_MS = 500;

let lastSignInTime: number | null = null;

function getLocalStorageSafe(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadLastSignInTimeFromStorage(): number | null {
  const storage = getLocalStorageSafe();
  if (!storage) return null;

  const raw = storage.getItem(LAST_SIGN_IN_STORAGE_KEY);
  if (!raw) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    storage.removeItem(LAST_SIGN_IN_STORAGE_KEY);
    return null;
  }

  return parsed;
}

function persistLastSignInTime(value: number | null): void {
  const storage = getLocalStorageSafe();
  if (!storage) return;

  if (value === null) {
    storage.removeItem(LAST_SIGN_IN_STORAGE_KEY);
  } else {
    storage.setItem(LAST_SIGN_IN_STORAGE_KEY, String(value));
  }
}

function getLastSignInTime(): number | null {
  const stored = loadLastSignInTimeFromStorage();
  if (stored !== null) {
    lastSignInTime = stored;
  }
  return lastSignInTime;
}

function createAuthExpiredError(originalError: unknown): Error {
  const error = originalError instanceof Error ? originalError : new Error("Session expired");
  Object.assign(error, {
    code: "AUTH_EXPIRED",
    messageKey: "hooks.audioRecording.errorDescriptions.sessionExpired",
  });
  return error;
}

function clearLastSignInTime(): void {
  lastSignInTime = null;
  persistLastSignInTime(null);
}

function markSignedOutState(): void {
  const storage = getLocalStorageSafe();
  storage?.setItem("isSignedIn", "false");
  clearLastSignInTime();
}

export function updateLastSignInTime(): void {
  const now = Date.now();
  lastSignInTime = now;
  persistLastSignInTime(now);
}

export function isWithinGracePeriod(): boolean {
  const startedAt = getLastSignInTime();
  if (!startedAt) return false;

  const elapsed = Math.max(0, Date.now() - startedAt);
  return elapsed < GRACE_PERIOD_MS;
}

export async function deleteAccount(): Promise<{ error?: Error }> {
  if (!OPENWHISPR_API_URL) {
    return { error: new Error("API not configured") };
  }

  try {
    const res = await fetch(`${OPENWHISPR_API_URL}/api/auth/delete-account`, {
      method: "DELETE",
      credentials: "include",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to delete account");
    }

    return {};
  } catch (error) {
    return { error: error instanceof Error ? error : new Error("Failed to delete account") };
  }
}

export async function signOut(): Promise<void> {
  try {
    if (window.electronAPI?.authClearSession) {
      await window.electronAPI.authClearSession();
    }
    await authClient.signOut();
    markSignedOutState();
  } catch {
    markSignedOutState();
  }
}

export async function withSessionRefresh<T>(operation: () => Promise<T>): Promise<T> {
  const startedInGracePeriod = isWithinGracePeriod();
  let graceRetriesUsed = 0;

  while (true) {
    try {
      return await operation();
    } catch (error: any) {
      const isAuthExpired =
        error?.code === "AUTH_EXPIRED" ||
        error?.message?.toLowerCase().includes("session expired") ||
        error?.message?.toLowerCase().includes("auth expired");

      if (!isAuthExpired) {
        throw error;
      }

      if (startedInGracePeriod && graceRetriesUsed < GRACE_RETRY_COUNT) {
        const delayMs = INITIAL_GRACE_RETRY_DELAY_MS * Math.pow(2, graceRetriesUsed);
        graceRetriesUsed += 1;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw createAuthExpiredError(error);
    }
  }
}

function getElectronOAuthCallbackURL(): string {
  const configuredUrl = (import.meta.env.VITE_OPENWHISPR_OAUTH_CALLBACK_URL || "").trim();
  if (configuredUrl) return configuredUrl;

  if (window.location.protocol !== "file:") return `${window.location.origin}/?panel=true`;

  const port = import.meta.env.VITE_DEV_SERVER_PORT || "5183";
  return `http://localhost:${port}/?panel=true`;
}

export async function signInWithSocial(provider: SocialProvider): Promise<{ error?: Error }> {
  // State enforced server-side by Better Auth.
  try {
    const isElectron = Boolean((window as any).electronAPI);

    if (isElectron) {
      const callbackURL = getElectronOAuthCallbackURL();

      const response = await fetch(`${AUTH_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openwhispr-source": "desktop",
        },
        credentials: "include",
        body: JSON.stringify({
          provider,
          callbackURL,
          newUserCallbackURL: callbackURL,
          disableRedirect: true,
        }),
      });

      const text = await response.text();

      if (!response.ok) {
        logger.error(`Social sign-in failed: ${response.status}`, text.slice(0, 200), "auth");
        return { error: new Error("Failed to initiate sign-in") };
      }

      let data: { url?: string };
      try {
        data = JSON.parse(text);
      } catch {
        logger.error("Non-JSON response from auth server", text.slice(0, 200), "auth");
        return { error: new Error("Unexpected response from auth server") };
      }

      if (!data.url) return { error: new Error("Failed to get OAuth URL") };

      openExternalLink(data.url);
      return {};
    }

    const callbackURL = `${window.location.href.split("?")[0].split("#")[0]}?panel=true`;
    await authClient.signIn.social({ provider, callbackURL, newUserCallbackURL: callbackURL });
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error : new Error("Social sign-in failed") };
  }
}

export async function requestPasswordReset(email: string): Promise<{ error?: Error }> {
  try {
    await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo: "https://openwhispr.com/reset-password",
    });
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error : new Error("Failed to send reset email") };
  }
}
