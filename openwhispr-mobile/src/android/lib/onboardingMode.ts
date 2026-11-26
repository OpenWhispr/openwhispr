import { createOnboardingMode } from '@/android/lib/onboardingModeCore';
import { androidOnboardingModePolicy } from '@/android/onboardingMode';

export const { saveOnboardingConfig, chooseOnboardingMode } = createOnboardingMode(
  androidOnboardingModePolicy,
);
