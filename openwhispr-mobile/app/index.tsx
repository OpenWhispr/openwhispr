import { Platform } from 'react-native';
import { Redirect } from 'expo-router';

// Anchors the app to Home on every fresh launch. Without a concrete root index,
// expo-router resolves the bare "/" URL to the alphabetically-first route group
// that has an index — (account), which sorts before (tabs) — so cold launches and
// the moment onboarding finishes would land on the Account screen. This redirect
// gives "/" a deterministic owner that sends users into the Record/home tab.
export default function Index() {
  if (Platform.OS === 'android' && localStorage.getItem('android-onboarding-done') !== 'true') {
    return <Redirect href="/android-setup" />;
  }
  return <Redirect href="/(tabs)/(record)" />;
}
