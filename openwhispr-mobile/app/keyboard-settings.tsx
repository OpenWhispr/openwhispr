import { Redirect } from 'expo-router';

// The keyboard opens <scheme>://keyboard-settings; land on the Keyboard screen, where its settings live.
export default function KeyboardSettings() {
  return <Redirect href="/(account)/keyboard" />;
}
