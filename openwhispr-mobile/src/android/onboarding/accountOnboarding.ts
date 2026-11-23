import { api } from '@/lib/apiClient';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Whether an account has already finished onboarding on Android (decision F2). The phone's own
 * flag (`android-onboarding-done`) is lost with a new phone or a reinstall, so the account
 * remembers it: openwhispr-api `GET/POST /api/me/android-onboarding`. Only an account that
 * finished on Android skips the tour; desktop and iPhone use doesn't count, and no answer means
 * the tour.
 */
const PATH = '/api/me/android-onboarding';
const DONE_KEY = 'android-onboarding-done';
// The account this phone last told; a phone that finished before this shipped tells on launch.
const REPORTED_KEY = 'android-onboarding-reported';
/** The question waits on the sign-in screen's Continue, so it gives up quickly. */
export const ONBOARDING_CHECK_TIMEOUT_MS = 3000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** This phone finished onboarding. Unreadable storage counts as done, so links never loop. */
export function onboardingDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === 'true';
  } catch {
    return true;
  }
}

function signedInAccount(): string | null {
  const { user, isGuest, sessionCookie } = useAuthStore.getState();
  return user && !user.isAnonymous && !isGuest && sessionCookie ? user.id : null;
}

/** True only when the server says this account finished onboarding on Android. */
export async function finishedOnboardingOnAndroid(
  timeoutMs = ONBOARDING_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  if (!signedInAccount()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const answer = await api.get<{ completed?: unknown }>(PATH, { signal: controller.signal });
    return answer?.completed === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tells the account this phone finished onboarding, once per account: at the end of onboarding
 * and on each launch until it lands (offline, or a phone that finished before this shipped).
 */
export async function reportAndroidOnboardingDone(): Promise<void> {
  const account = signedInAccount();
  if (!account || read(DONE_KEY) !== 'true' || read(REPORTED_KEY) === account) return;
  try {
    await api.post(PATH);
    localStorage.setItem(REPORTED_KEY, account);
  } catch {
    // Tried again on the next launch.
  }
}
