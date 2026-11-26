import { Stack } from 'expo-router';
import { customHeaderStackOptions } from '@/android/shared/config/navigation';

export default function DictionaryLayout() {
  return (
    <Stack screenOptions={customHeaderStackOptions}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
