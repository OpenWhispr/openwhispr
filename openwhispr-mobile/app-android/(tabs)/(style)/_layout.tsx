import { Stack } from 'expo-router';
import { customHeaderStackOptions } from '@/android/shared/config/navigation';

export default function StyleLayout() {
  return <Stack screenOptions={customHeaderStackOptions} />;
}
