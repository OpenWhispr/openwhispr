import { Redirect } from 'expo-router';

// Preferences moved onto Settings; old links land there.
export default function PreferencesScreen() {
  return <Redirect href="/(account)" />;
}
