import { Stack } from 'expo-router';
import { glassStackOptions } from '@/android/shared/config/navigation';

export default function RecordLayout() {
  return (
    <Stack screenOptions={glassStackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}
