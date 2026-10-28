import { router } from 'expo-router';

export function navigateHome(fromTabs: boolean): void {
  // Expo targets the native tab navigator for a tab switch, and it cannot handle REPLACE.
  if (fromTabs) {
    router.navigate('/(tabs)/(record)');
  } else {
    router.replace('/(tabs)/(record)');
  }
}
