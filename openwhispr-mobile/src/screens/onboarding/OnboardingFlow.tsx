import { useEffect, type ComponentType, type ReactElement } from 'react';
import { View } from 'react-native';
import { useOnboardingStore, type OnboardingStepId } from '@/store/useOnboardingStore';
import { GetStartedStep } from './steps/GetStartedStep';
import { SecurityFirstStep } from './steps/SecurityFirstStep';
import { WelcomeStep } from './steps/WelcomeStep';
import { KeyboardIntroStep } from './steps/KeyboardIntroStep';
import { KeyboardSwitchStep } from './steps/KeyboardSwitchStep';
import { MicrophoneStep } from './steps/MicrophoneStep';
import { DictationEmailStep } from './steps/DictationEmailStep';
import { PrivacyModeStep } from './steps/PrivacyModeStep';
import { PrivateDownloadStep } from './steps/PrivateDownloadStep';
import { LanguageStep } from './steps/LanguageStep';
import { NotificationsStep } from './steps/NotificationsStep';
import { GraduationStep } from './steps/GraduationStep';
import { PaywallStep } from './steps/PaywallStep';
import { CreateAccountStep } from './steps/CreateAccountStep';
import { TrackingPermissionStep } from './steps/TrackingPermissionStep';

// Exhaustive by type: adding a step id without a screen is a compile error,
// which is safer than falling back to a placeholder at runtime.
const STEP_COMPONENTS: Record<OnboardingStepId, ComponentType> = {
  'get-started': GetStartedStep,
  'security-first': SecurityFirstStep,
  welcome: WelcomeStep,
  'keyboard-intro': KeyboardIntroStep,
  'keyboard-switch': KeyboardSwitchStep,
  microphone: MicrophoneStep,
  'dictation-email': DictationEmailStep,
  'privacy-mode': PrivacyModeStep,
  'private-download': PrivateDownloadStep,
  language: LanguageStep,
  notifications: NotificationsStep,
  graduation: GraduationStep,
  paywall: PaywallStep,
  'create-account': CreateAccountStep,
  'tracking-permission': TrackingPermissionStep,
};

export function OnboardingFlow(): ReactElement {
  const hydrated = useOnboardingStore((s) => s.hydrated);
  const hydrate = useOnboardingStore((s) => s.hydrate);
  const currentStep = useOnboardingStore((s) => s.currentStep);

  useEffect(() => {
    if (!hydrated) {
      hydrate();
    }
  }, [hydrated, hydrate]);

  if (!hydrated) {
    return <View className="flex-1 bg-systemBackground" />;
  }

  const StepComponent = STEP_COMPONENTS[currentStep];
  return <StepComponent />;
}
