import { Stack } from 'expo-router';
import { customHeaderStackOptions, glassStackOptions } from '@/config/navigation';

export default function NotesLayout() {
  return (
    <Stack screenOptions={glassStackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="notes" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={customHeaderStackOptions} />
      <Stack.Screen name="actions" options={{ title: 'Actions', headerLargeTitle: false }} />
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
        options={{ title: 'Enroll Voice', headerLargeTitle: false }}
      />
    </Stack>
  );
}
