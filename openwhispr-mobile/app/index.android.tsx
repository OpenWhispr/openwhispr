import { Redirect } from 'expo-router';

export default function Index() {
  if (localStorage.getItem('android-onboarding-done') !== 'true') {
    return <Redirect href="/android-setup" />;
  }
  return <Redirect href="/(tabs)/(record)" />;
}
