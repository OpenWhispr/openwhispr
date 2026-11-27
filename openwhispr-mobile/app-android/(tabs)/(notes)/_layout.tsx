import { Stack } from 'expo-router';
import { customHeaderStackOptions, glassStackOptions } from '@/android/shared/config/navigation';

// No unstable_settings.initialRouteName here: with one, a cold start's "/" resolves to this tab's
// index instead of Home's, so the app opened on Notes. A withAnchor push still puts the index (the
// first screen below) under a note opened from another tab.

export default function NotesLayout() {
  return (
    <Stack screenOptions={glassStackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="notes" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={customHeaderStackOptions} />
      <Stack.Screen name="import-audio" options={{ headerShown: false }} />
      <Stack.Screen
        name="meeting-record"
        options={{ title: 'Record meeting', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="voice-profiles"
        options={{ title: 'Voice Profiles', headerLargeTitle: false }}
      />
      <Stack.Screen name="voice-profile" options={{ title: 'Profile', headerLargeTitle: false }} />
      <Stack.Screen
        name="voice-enrollment"
        options={{ title: 'Voice Sample', headerLargeTitle: false }}
      />
    </Stack>
  );
}
