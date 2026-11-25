import { Redirect } from 'expo-router';

// The keyboard opens <scheme>://keyboard-settings; land on Preferences, where its settings live.
export default function KeyboardSettings() {
  return <Redirect href="/(account)/preferences" />;
}
