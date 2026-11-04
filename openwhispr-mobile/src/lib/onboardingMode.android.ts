import { createOnboardingMode } from './onboardingModeCore';
import { androidOnboardingModePolicy } from '../android/onboardingMode';

export const { saveOnboardingConfig, chooseOnboardingMode } = createOnboardingMode(
  androidOnboardingModePolicy,
);
