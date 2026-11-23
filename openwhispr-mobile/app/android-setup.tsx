import { router } from 'expo-router';
import { Onboarding } from '@/android/Onboarding';
import { reportAndroidOnboardingDone } from '@/android/onboarding/accountOnboarding';
export default function AndroidSetup() {
  return (
    <Onboarding
      onFinish={() => {
        localStorage.setItem('android-onboarding-done', 'true');
        // The account remembers it, so a new phone or a reinstall skips the tour (F2).
        void reportAndroidOnboardingDone();
        router.replace('/(tabs)/(record)');
      }}
    />
  );
}
