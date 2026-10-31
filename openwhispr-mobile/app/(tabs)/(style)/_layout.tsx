import { Stack } from 'expo-router';
import { customHeaderStackOptions } from '@/config/navigation';

export default function StyleLayout() {
  return <Stack screenOptions={customHeaderStackOptions} />;
}
