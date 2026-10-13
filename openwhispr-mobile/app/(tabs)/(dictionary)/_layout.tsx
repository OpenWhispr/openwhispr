import { Stack } from 'expo-router';
import { customHeaderStackOptions } from '@/config/navigation';

export default function DictionaryLayout() {
  return (
    <Stack screenOptions={customHeaderStackOptions}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
