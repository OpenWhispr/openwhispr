import * as SecureStore from 'expo-secure-store';
// Type-only, so this does not create a runtime cycle with the store, which
// imports this module for values.
import type { OnboardingStepId } from '@/store/useOnboardingStore';

const ONBOARDING_COMPLETE_KEY = 'onboarding_complete';
const ONBOARDING_PROGRESS_KEY = 'onboarding_progress';
const TRACKING_AUTHORIZATION_REQUEST_ATTEMPTED_KEY = 'tracking_authorization_request_attempted';

/** Where a fresh install starts, and the fallback for unrecognised saved progress. */
export const FIRST_ONBOARDING_STEP: OnboardingStepId = 'get-started';

export interface OnboardingProgress {
  step: string;
  keyboardInstalled: boolean;
  permissionsGranted: {
    microphone: boolean;
    notifications: boolean;
  };
}

const defaultProgress: OnboardingProgress = {
  step: FIRST_ONBOARDING_STEP,
  keyboardInstalled: false,
  permissionsGranted: {
    microphone: false,
    notifications: false,
  },
};

export class OnboardingService {
  static async isOnboardingComplete(): Promise<boolean> {
    try {
      const value = await SecureStore.getItemAsync(ONBOARDING_COMPLETE_KEY);
      return value === 'true';
    } catch {
      return false;
    }
  }

  static async completeOnboarding(): Promise<void> {
    await SecureStore.setItemAsync(ONBOARDING_COMPLETE_KEY, 'true');
    await SecureStore.deleteItemAsync(ONBOARDING_PROGRESS_KEY);
  }

  static async hasAttemptedTrackingAuthorizationRequest(): Promise<boolean> {
    try {
      const value = await SecureStore.getItemAsync(TRACKING_AUTHORIZATION_REQUEST_ATTEMPTED_KEY);
      return value === 'true';
    } catch {
      return true;
    }
  }

  static async markTrackingAuthorizationRequestAttempted(): Promise<void> {
    await SecureStore.setItemAsync(TRACKING_AUTHORIZATION_REQUEST_ATTEMPTED_KEY, 'true');
  }

  static async resetOnboarding(): Promise<void> {
    await SecureStore.deleteItemAsync(ONBOARDING_COMPLETE_KEY);
    await SecureStore.deleteItemAsync(ONBOARDING_PROGRESS_KEY);
  }

  static async getProgress(): Promise<OnboardingProgress> {
    try {
      const raw = await SecureStore.getItemAsync(ONBOARDING_PROGRESS_KEY);
      if (!raw) return defaultProgress;
      const parsed = JSON.parse(raw) as Partial<OnboardingProgress>;
      return {
        ...defaultProgress,
        ...parsed,
        permissionsGranted: {
          ...defaultProgress.permissionsGranted,
          ...(parsed.permissionsGranted ?? {}),
        },
      };
    } catch {
      return defaultProgress;
    }
  }

  static async setProgress(progress: OnboardingProgress): Promise<void> {
    await SecureStore.setItemAsync(ONBOARDING_PROGRESS_KEY, JSON.stringify(progress));
  }
}
