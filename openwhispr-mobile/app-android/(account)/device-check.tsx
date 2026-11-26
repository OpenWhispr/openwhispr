import { Platform } from 'react-native';
import { Redirect } from 'expo-router';
import DeviceCheckScreen from '@/android/DeviceCheckScreen';
export default function DeviceCheckRoute() {
  return Platform.OS === 'android' ? (
    <DeviceCheckScreen />
  ) : (
    <Redirect href="/(account)/ai-models" />
  );
}
