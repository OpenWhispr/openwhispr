import { Stack } from 'expo-router';
import { customHeaderStackOptions } from '@/config/navigation';

export default function ReferralLayout() {
  return (
    <Stack screenOptions={customHeaderStackOptions}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
