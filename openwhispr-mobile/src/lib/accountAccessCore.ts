import { Alert } from 'react-native';
import { router } from 'expo-router';
import { isAccountRequiredError } from '@/lib/accountRequiredError';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { AuthUser } from '@/lib/authClient';
import type { ProcessingMode } from '@/types';

export interface AccountAccessPresentation {
  localModeAction: string;
  cloudMessage: (
    feature: string,
    anonymous: boolean,
    privateMode: boolean,
    fallback: string,
  ) => string;
  cloudOnlyMessage: (feature: string, anonymous: boolean, fallback: string) => string;
  alertLabels: (anonymous: boolean) => { title: string; cancel: string; account: string };
}

export function createAccountAccess(presentation?: AccountAccessPresentation) {
  // Deliberately `!user`, not requiresRealAccount: cloud transcription is exactly
  // what an anonymous onboarding session exists to do, and the API leaves
  // /api/transcribe ungated for it.
  function accountRequiredForCloud(user: AuthUser | null): boolean {
    return !user;
  }

  /**
   * True when the caller holds nothing the API would accept for a gated feature.
   * An anonymous onboarding session is a real session — it carries dictation and
   * the paywall — but every endpoint behind requireAccount refuses it with 403
   * ACCOUNT_REQUIRED, so for those it counts as no account at all.
   */
  function requiresRealAccount(user: AuthUser | null): boolean {
    return !user || Boolean(user.isAnonymous);
  }

  function cloudModeRequiresAccount(mode: ProcessingMode, user: AuthUser | null): boolean {
    return mode === 'cloud' && accountRequiredForCloud(user);
  }

  // Cloud meetings run on the realtime token, which the API keeps behind a real
  // account (unlike /api/transcribe), so an anonymous session records locally
  // exactly as a guest does.
  function canRunCloudMeeting(user: AuthUser | null, mode: ProcessingMode): boolean {
    return mode !== 'private' && !requiresRealAccount(user);
  }

  function getCloudAccountRequiredMessage(feature: string, anonymous = false): string {
    const action = `${anonymous ? 'Create an account' : 'Sign in'} to use ${feature} with cloud processing`;
    // Already in Private Mode, which is what turning it off asks Cloud for, so don't offer it back.
    const privateMode = useProcessingModeStore.getState().activeMode === 'private';
    const fallback = privateMode
      ? `${action}.`
      : `${action}, or ${presentation?.localModeAction ?? 'set Dictation to On-Device'} in Account → AI Models.`;
    return presentation
      ? presentation.cloudMessage(feature, anonymous, privateMode, fallback)
      : fallback;
  }

  // For features with no local model (AI actions, AI chat): Private Mode is not
  // an alternative, so don't suggest it as one.
  function getCloudOnlyAccountRequiredMessage(feature: string, anonymous = false): string {
    const fallback = `${anonymous ? 'Create an account' : 'Sign in'} to use ${feature}. This feature always uses cloud AI, even in Local Mode.`;
    return presentation ? presentation.cloudOnlyMessage(feature, anonymous, fallback) : fallback;
  }

  function showAccountRequiredAlert(feature: string, options?: { cloudOnly?: boolean }): void {
    // An anonymous onboarding session already has a user; what it lacks is an
    // account, and the Account screen has nothing to offer it. Send it straight
    // to sign-up instead of a screen whose only action would be Sign Out.
    const anonymous = useAuthStore.getState().user?.isAnonymous === true;
    const message = options?.cloudOnly
      ? getCloudOnlyAccountRequiredMessage(feature, anonymous)
      : getCloudAccountRequiredMessage(feature, anonymous);
    const labels = presentation?.alertLabels(anonymous);
    Alert.alert(labels?.title ?? (anonymous ? 'Create an account' : 'Sign in required'), message, [
      { text: labels?.cancel ?? 'Cancel', style: 'cancel' },
      anonymous
        ? { text: labels?.account ?? 'Create Account', onPress: () => router.push('/auth') }
        : { text: labels?.account ?? 'Account', onPress: () => router.push('/(account)') },
    ]);
  }

  /**
   * Backstop for a gated endpoint the client-side checks did not anticipate:
   * turns the API's 403 ACCOUNT_REQUIRED into the same prompt those checks show,
   * instead of letting a bare "HTTP 403" reach an alert. Returns whether it
   * handled the error, so callers can `if (handled) return;` before their own
   * generic error path.
   */
  function handleAccountRequiredError(
    error: unknown,
    feature: string,
    options?: { cloudOnly?: boolean },
  ): boolean {
    if (!isAccountRequiredError(error)) return false;
    showAccountRequiredAlert(feature, options);
    return true;
  }

  return {
    accountRequiredForCloud,
    requiresRealAccount,
    cloudModeRequiresAccount,
    canRunCloudMeeting,
    getCloudAccountRequiredMessage,
    getCloudOnlyAccountRequiredMessage,
    showAccountRequiredAlert,
    handleAccountRequiredError,
  };
}
