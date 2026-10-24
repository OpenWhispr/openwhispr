import { router } from 'expo-router';
import { Onboarding } from '@/android/Onboarding';
export default function AndroidSetup() {
  return (
    <Onboarding
      onFinish={() => {
        localStorage.setItem('android-onboarding-done', 'true');
        router.replace('/(tabs)/(record)');
      }}
    />
  );
}
